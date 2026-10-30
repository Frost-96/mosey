import { test, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { openSettings, closeSettings } from "./support/settings";
import { createPetTestSession } from "./support/pet-session";

test("opening settings waits for confirmed values instead of the initial React view", async () => {
  const session = await createPetTestSession({ dock: "empty" });
  const { app } = await session.launch();
  const first = await openSettings(app, { run: session.run });
  const snapshot = await session.run("settings-readiness:first.evaluate", () =>
    first.evaluate(() => window.moseySettings.get()),
  );
  await closeSettings(app, { run: session.run });
  // Hold incoming settings at the IPC boundary until the native window is
  // observed visible, then release a non-default size and approval state.
  await session.run("settings-readiness:app.evaluate", () =>
    app.evaluate(({ app, ipcMain }, snapshot) => {
      const pending: (() => void)[] = [];
      let released = false;
      const deliver = (send: () => void) => {
        if (released) send();
        else pending.push(send);
      };
      const next = {
        ...snapshot,
        revision: 10000,
        size: 110,
        login: { status: "requires-approval" },
      };
      ipcMain.removeHandler("settings:get");
      ipcMain.handle(
        "settings:get",
        () => new Promise((resolve) => deliver(() => resolve(next))),
      );
      app.on("browser-window-created", (_event, window) => {
        const send = window.webContents.send.bind(window.webContents);
        window.webContents.send = (channel, ...args) => {
          if (channel === "settings:state") deliver(() => send(channel, next));
          else send(channel, ...args);
        };
        const isVisible = window.isVisible.bind(window);
        let scheduled = false;
        window.isVisible = () => {
          const visible = isVisible();
          if (visible && !scheduled) {
            scheduled = true;
            setTimeout(() => {
              released = true;
              pending.splice(0).forEach((release) => release());
            }, 200);
          }
          return visible;
        };
      });
    }, snapshot),
  );
  const settings = await openSettings(app, { run: session.run });
  expect(
    await session.run("settings-readiness:settings.textContent", () =>
      settings.locator("output").textContent(),
    ),
  ).toBe("110");
  expect(
    await session.run("settings-readiness:settings.isChecked", () =>
      settings.getByRole("checkbox").isChecked(),
    ),
  ).toBe(false);
  expect(
    await session.run("settings-readiness:settings.isDisabled", () =>
      settings.getByRole("checkbox").isDisabled(),
    ),
  ).toBe(true);
  expect(
    await session.run("settings-readiness:settings.textContent", () =>
      settings.locator("#login-status").textContent(),
    ),
  ).toContain("等待批准");
  await session.quit();
});

test("opening settings tolerates delayed renderer controls within its readiness deadline", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: { version: 1, size: "large", visibility: "hidden" },
  });
  const { app } = await session.launch();
  const trace = path.join(session.evidence, "settings-script-delay.jsonl");
  await session.run("settings-readiness:delay-renderer-script", () =>
    app.evaluate(({ session }, trace) => {
      let delayed = false;
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (
          delayed ||
          details.resourceType !== "script" ||
          !new URL(details.url).pathname.includes("/settings")
        ) {
          callback({ cancel: false });
          return;
        }
        delayed = true;
        const record = (event: string) =>
          process.getBuiltinModule("node:fs").appendFileSync(
            trace,
            JSON.stringify({
              event,
              at: performance.now(),
              url: details.url,
            }) + "\n",
          );
        record("held");
        // Delay one real module response after the settings document exists.
        // This is below the existing 15s readiness budget, above the old 1s probe.
        setTimeout(() => {
          record("released");
          callback({ cancel: false });
        }, 2000);
      });
    }, trace),
  );
  const settings = await openSettings(app, { run: session.run });
  expect(
    await session.run("settings-readiness:delayed-character", () =>
      settings.getByRole("combobox", { name: "角色" }).inputValue(),
    ),
  ).toBe("whale");
  expect(
    await session.run("settings-readiness:delayed-size", () =>
      settings.locator("output").textContent(),
    ),
  ).toBe("240");
  expect(
    await session.run("settings-readiness:delayed-native-visibility", () =>
      app.evaluate(({ BrowserWindow }) => ({
        settings: BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Mosey 设置")!
          .isVisible(),
        pet: BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Mosey")!
          .isVisible(),
      })),
    ),
  ).toEqual({ settings: true, pet: false });
  const events = await session.run("settings-readiness:delay-evidence", () =>
    readFile(trace, "utf8"),
  );
  expect(events).toContain('"event":"held"');
  expect(events).toContain('"event":"released"');
  await session.quit();
});

test("a stalled settings close cancels reopening and profile writes while retaining process evidence", async () => {
  const session = await createPetTestSession({ dock: "empty" });
  const { app } = await session.launch();
  await openSettings(app, { run: session.run });
  const child = app.process();
  // Stop the native close at the driver boundary. The real application still
  // belongs to the session, whose cancellation must prevent all later work.
  const stalled = vi
    .spyOn(app, "evaluate")
    .mockImplementationOnce(() => new Promise(() => {}));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closing = closeSettings(app, {
      run: (label, action) =>
        session.run(label, action, {
          timeout: label === "settings-native-close" ? 100 : 5000,
        }),
    });
    await expect(
      Promise.race([
        closing,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Settings close ignored the session deadline")),
            4000,
          );
        }),
      ]),
    ).rejects.toThrow(/settings-native-close did not complete within 100ms/);
    await expect(openSettings(app, { run: session.run })).rejects.toThrow(
      /closed or cancelled/,
    );
    await expect(
      session.writeProfileFile("after-close.json", "unexpected"),
    ).rejects.toThrow(/closed or cancelled/);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    const evidence = await readFile(
      path.join(session.evidence, "progress.jsonl"),
      "utf8",
    );
    expect(evidence).toContain('"event":"first-failure"');
    expect(evidence).toContain(
      "settings-native-close did not complete within 100ms",
    );
    expect(evidence).toContain('"event":"app-exited"');
    expect(evidence).toContain('"event":"cleanup-complete"');
  } finally {
    clearTimeout(timer);
    stalled.mockRestore();
    await session.close();
  }
});
