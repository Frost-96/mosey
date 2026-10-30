import { test, expect, vi } from "vitest";
import {
  _electron as electron,
  type Page,
  type ElectronApplication,
} from "playwright";
import { writeFile, readFile, access, realpath } from "node:fs/promises";
import path from "node:path";
import { openSettings } from "./support/settings";
import { createLoginTestSession } from "./support/login-session";
import {
  createPetTestSession,
  type SessionOperation,
} from "./support/pet-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("an assertion after enabling the real login service restores registration and keeps the original failure", async () => {
  const session = await createLoginTestSession();
  const { app } = await session.launch({ timeout: 20000 });
  const child = app.process();
  await session.run("login-enable-before-assertion", () =>
    app.evaluate(({ app }) =>
      app.setLoginItemSettings({ type: "mainAppService", openAtLogin: true }),
    ),
  );
  expect(["enabled", "requires-approval"]).toContain(
    (await session.readLogin(app)).system.status,
  );
  const original = new Error("assertion after the real login request");
  await expect(
    session.run("login-assertion", () => Promise.reject(original)),
  ).rejects.toBe(original);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  const evidence = (
    await readFile(path.join(session.evidence, "login-items.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const restored = evidence.find((entry) => entry.event === "login-restored")
    .detail.system;
  expect(restored.openAtLogin).toBe(false);
  expect(["enabled", "requires-approval"]).not.toContain(restored.status);
  expect(evidence.some((entry) => entry.event === "unregistered")).toBe(true);
  await expect(access(session.bundle)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(session.launch()).rejects.toThrow(/closed|cancelled/);
});

test("cancelling a late login launch restores its real service without a cleanup relaunch", async () => {
  const controller = new AbortController();
  const session = await createLoginTestSession({ signal: controller.signal });
  const first = await session.launch({ timeout: 20000 });
  await session.run("login-request-before-relaunch", () =>
    first.app.evaluate(({ app }) =>
      app.setLoginItemSettings({
        type: "mainAppService",
        openAtLogin: true,
      }),
    ),
  );
  expect(["enabled", "requires-approval"]).toContain(
    (await session.readLogin(first.app)).system.status,
  );
  await session.quit();
  const acquired = deferred<ElectronApplication>();
  const release = deferred<void>();
  const realLaunch = electron.launch.bind(electron);
  const delayed = vi
    .spyOn(electron, "launch")
    .mockImplementation(async (options) => {
      const app = await realLaunch(options);
      acquired.resolve(app);
      await release.promise;
      return app;
    });
  try {
    const launching = session.launch({ timeout: 20000 });
    const app = await acquired.promise;
    const child = app.process();
    controller.abort(
      new Error("cancel while the login application is being acquired"),
    );
    release.resolve();
    await expect(launching).rejects.toThrow(/cancel/);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await expect(session.launch()).rejects.toThrow(/closed|cancelled/);
    await session.close();
    const evidence = (
      await readFile(path.join(session.evidence, "login-items.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      evidence.find((entry) => entry.event === "login-restored").detail.system
        .openAtLogin,
    ).toBe(false);
    expect(evidence.some((entry) => entry.event === "unregistered")).toBe(true);
    await expect(access(session.bundle)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const progress = await readFile(
      path.join(session.evidence, "progress.jsonl"),
      "utf8",
    );
    expect(progress.match(/"event":"app-acquired"/g)).toHaveLength(2);
    // Only the first launch reached presentation readiness. Cancellation of
    // the delayed acquisition does not falsely claim another observed DPR.
    expect(progress.match(/"event":"observed-scale"/g)).toHaveLength(1);
  } finally {
    release.resolve();
    delayed.mockRestore();
  }
});

test("a failed platform restoration preserves its bundle and original failure without late writes", async () => {
  let unavailable = true;
  let cleanupRun: SessionOperation | undefined;
  const session = await createPetTestSession({
    dock: "empty",
    packagedPlatform: {
      async restore({ app, run }) {
        cleanupRun = run;
        if (unavailable)
          await run(
            "unavailable-platform-restoration",
            () => app!.evaluate(() => new Promise<void>(() => {})),
            { timeout: 100 },
          );
      },
    },
  });
  const root = path.dirname(session.profile);
  const { app } = await session.launch();
  const child = app.process();
  const original = new Error("original login assertion");
  try {
    await expect(
      session.run("login-assertion", () => Promise.reject(original)),
    ).rejects.toMatchObject({ cause: original });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await expect(access(path.join(root, "Mosey.app"))).resolves.toBeUndefined();
    const lateFile = path.join(session.evidence, "late-platform-write");
    await expect(
      cleanupRun!("late-platform-write", () =>
        writeFile(lateFile, "forbidden"),
      ),
    ).rejects.toThrow(/no longer active/);
    await expect(access(lateFile)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    // This harness-only resource never registered an OS login item. Removing
    // its injected transport obstruction permits cleanup without a relaunch.
    unavailable = false;
  }
  await session.close();
  await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
});

test("packaged platform restoration can use the live owned app after a scenario failure", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    packagedPlatform: {
      async restore({ app, run }) {
        if (!app) throw new Error("The owned application is unavailable");
        await run("platform-restoration", () =>
          app.evaluate(
            (_electron, output) => {
              process
                .getBuiltinModule("node:fs")
                .writeFileSync(
                  output,
                  JSON.stringify({ pid: process.pid, restored: true }),
                );
            },
            path.join(session.evidence, "platform-restored.json"),
          ),
        );
      },
    },
  });
  const { app } = await session.launch();
  const child = app.process();
  const original = new Error("assertion after acquiring the platform resource");
  await expect(
    session.run("scenario-assertion", () => Promise.reject(original)),
  ).rejects.toBe(original);
  expect(
    JSON.parse(
      await readFile(
        path.join(session.evidence, "platform-restored.json"),
        "utf8",
      ),
    ),
  ).toEqual({ pid: child.pid, restored: true });
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test("login launch follows the packaged app service across changes, quit and restart", async () => {
  const session = await createLoginTestSession();
  const executable = await session.run("login-owned-executable", () =>
    realpath(path.join(session.bundle, "Contents/MacOS/Mosey")),
  );
  let app: ElectronApplication;
  let pet: Page;
  let settings: Page;
  const run = session.run;
  const launch = async () => {
    ({ app, pet } = await session.launch({ timeout: 20000 }));
    await run("login-offline", () => app.context().setOffline(true));
    settings = await openSettings(app, { run });
  };
  const read = async () => {
    const result = await session.readLogin(app);
    expect(result.executable).toBe(executable);
    const login = settings.getByRole("region", { name: "开机启动" });
    // Unchecked alone also matches the loading view. Observe both properties.
    await expect
      .poll(() =>
        run("login-checkbox-state", () =>
          login.getByRole("checkbox").evaluate((input: HTMLInputElement) => ({
            checked: input.checked,
            disabled: input.disabled,
          })),
        ),
      )
      .toEqual({
        checked:
          result.system.status === "enabled" && result.system.openAtLogin,
        disabled: result.system.status === "requires-approval",
      });
    if (result.system.status === "requires-approval")
      await expect
        .poll(() => run("login-approval-message", () => login.textContent()))
        .toContain("等待批准");
    return result;
  };
  const click = async () => {
    const previous = (await session.readLogin(app)).system.status;
    await run("login-body-menu-tracking", () =>
      app.evaluate(({ Menu }) => {
        // Only native menu tracking is controlled. The system service stays real.
        Menu.prototype.popup = function (options) {
          Reflect.set(globalThis, "loginBodyMenu", this);
          Reflect.set(this, "trackingCallback", options?.callback);
        };
      }),
    );
    // Independently observed opaque pixels remain the hit target. Session
    // readiness distinguishes document, presentation and the first paint.
    const body = await run(
      "login-opaque-body",
      () =>
        pet.waitForFunction(
          () => {
            const canvas = document.querySelector("canvas")!;
            const { data, width, height } = canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height);
            for (let y = Math.floor(height * 0.65); y < height - 8; y++)
              for (let x = Math.floor(width * 0.4); x < width - 8; x++)
                if (
                  [0, -4, 4].every((dy) =>
                    [0, -4, 4].every(
                      (dx) => data[((y + dy) * width + x + dx) * 4 + 3]! > 250,
                    ),
                  )
                )
                  return {
                    x: (x + 0.5) / devicePixelRatio,
                    y: (y + 0.5) / devicePixelRatio,
                  };
            return undefined;
          },
          undefined,
          { timeout: 10000 },
        ),
      { timeout: 10000 },
    );
    const point = (await run("login-body-point", () => body.jsonValue()))!;
    await run("login-body-handle-release", () => body.dispose());
    await run("login-body-right-click", () =>
      pet.mouse.click(point.x, point.y, { button: "right" }),
    );
    await expect
      .poll(() =>
        run("login-body-menu-open", () =>
          app.evaluate(() => !!Reflect.get(globalThis, "loginBodyMenu")),
        ),
      )
      .toBe(true);
    const checked = await run("login-menu-state", () =>
      app.evaluate(
        () =>
          Reflect.get(globalThis, "loginBodyMenu").items.find(
            (item: { label: string }) => item.label === "Launch at Login",
          ).checked,
      ),
    );
    expect(checked).toBe(previous === "enabled");
    await run("login-menu-toggle", () =>
      app.evaluate(() => {
        const menu = Reflect.get(globalThis, "loginBodyMenu");
        menu.items
          .find((item: { label: string }) => item.label === "Launch at Login")
          .click();
        Reflect.get(menu, "trackingCallback")?.();
        Reflect.set(globalThis, "loginBodyMenu", undefined);
      }),
    );
    await expect
      .poll(async () => (await session.readLogin(app)).system.status)
      .not.toBe(previous);
  };
  await launch();
  expect((await read()).system.openAtLogin).toBe(false);
  await click();
  const requested = await read();
  expect(["enabled", "requires-approval"]).toContain(requested.system.status);
  await session.quit();
  await launch();
  const restarted = await read();
  expect(restarted.system.status).toBe(requested.system.status);
  expect(restarted.system.openAtLogin).toBe(requested.system.openAtLogin);
  // System Settings can change the real OS boundary while Mosey is running.
  await run("login-external-disable", () =>
    app.evaluate(({ app }) =>
      app.setLoginItemSettings({ type: "mainAppService", openAtLogin: false }),
    ),
  );
  await run("login-activate-refresh", () =>
    app.evaluate(({ app }) => {
      app.emit("activate");
    }),
  );
  expect((await read()).system.openAtLogin).toBe(false);
  await click();
  const reenabled = await read();
  if (reenabled.system.status === "requires-approval")
    await run("login-cancel-approval", () =>
      settings.getByRole("button", { name: "取消待批准请求" }).click(),
    );
  else await click();
  expect((await read()).system.openAtLogin).toBe(false);
  await session.quit();
  await launch();
  expect((await read()).system.openAtLogin).toBe(false);
  await session.close();
});
