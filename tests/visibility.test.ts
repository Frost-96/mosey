import { test, expect } from "vitest";
import { mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

test("manual visibility survives restart, duplicate launches and damaged preferences", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      visibility: "visible",
      size: 240,
    },
  });
  const { profile, mark } = session;
  const initial = await session.launch();
  let app = initial.app;
  const pet = initial.pet;
  let launches = 1;
  const launch = async () => {
    const next = await session.launch();
    app = next.app;
    launches++;
    return next;
  };
  const close = () => session.quit();
  const evaluate = <T>(
    fn: (electron: typeof import("electron")) => T | Promise<T>,
  ) => session.run("visibility-driver", () => app.evaluate(fn));
  const read = <T>(fn: () => T | Promise<T>) =>
    session.run("visibility-renderer", () => pet.evaluate(fn));
  const visible = () =>
    evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.isVisible(),
    );
  const invoke = async (label: string) => {
    mark(label);
    await session.run(label, () =>
      app.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "Mosey")
          ?.submenu?.items.find((item) => item.label === label);
        if (!item) throw new Error(`Missing menu item: ${label}`);
        item.click();
      }, label),
    );
    mark(`${label}-complete`);
  };
  // Native visibility can precede the initial renderer document commit.
  // Wait for that document, then its actual drawing, before sampling frames.
  await expect
    .poll(
      () =>
        read(() => {
          const canvas = document.querySelector("canvas")!;
          return Array.from(
            canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height).data,
          ).filter((value, i) => i % 4 === 3 && value > 127).length;
        }),
      { timeout: 10000 },
    )
    .toBeGreaterThan(5000);
  await expect.poll(visible).toBe(true);
  // Initial Vite dependency optimization may reload the development document.
  mark("network-idle");
  await session.run("network-idle", () => pet.waitForLoadState("networkidle"));
  mark("animation");
  const pixels = () =>
    read(() => document.querySelector("canvas")!.toDataURL());
  const idleFrames = new Set<string>();
  const idleUntil = Date.now() + 2200;
  while (Date.now() < idleUntil) {
    idleFrames.add(await pixels());
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  // External renderer instrumentation only; the production app has no test hooks.
  await read(() => {
    const counts = { draws: 0 };
    Reflect.set(window, "visibilityEvidence", counts);
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    Reflect.set(
      CanvasRenderingContext2D.prototype,
      "drawImage",
      function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        counts.draws++;
        return Reflect.apply(draw, this, args);
      },
    );
  });
  const idleWorkBefore = await read(() => ({
    ...Reflect.get(window, "visibilityEvidence"),
  }));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const idleWorkAfter = await read(() => ({
    ...Reflect.get(window, "visibilityEvidence"),
  }));
  const idleWork = {
    draws: idleWorkAfter.draws - idleWorkBefore.draws,
  };
  // Observe low-frequency Canvas work without binding to its scheduling mechanism.
  expect(idleWork.draws).toBeGreaterThanOrEqual(1);
  expect(idleWork.draws).toBeLessThanOrEqual(4);
  await session.run("pet-click", () => pet.mouse.click(120, 180));
  await expect
    .poll(async () => idleFrames.has(await pixels()), { interval: 30 })
    .toBe(false);
  mark("hide");
  await invoke("Hide Mosey");
  await expect.poll(visible).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const counts = () => read(() => Reflect.get(window, "visibilityEvidence"));
  const stopped = await counts();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const afterHidden = await counts();
  expect(afterHidden).toEqual(stopped);
  mark("show");
  await invoke("Show Mosey");
  await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
  // Restoring must remain inactive and return to idle rather than resume the response.
  expect(
    await evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.isFocused(),
    ),
  ).toBe(false);
  await invoke("Hide Mosey");
  await expect.poll(visible).toBe(false);
  mark("restart-hidden");
  await close();
  await launch();
  expect(await visible()).toBe(false);
  mark("duplicate");
  expect((await session.launchDuplicate()).exitCode).toBe(0);
  expect(await visible()).toBe(false);
  await invoke("Show Mosey");
  await expect.poll(visible).toBe(true);
  await expect
    .poll(() =>
      evaluate(({ BrowserWindow, screen }) => {
        const pet = BrowserWindow.getAllWindows()[0]!;
        return (
          pet.getBounds().y + pet.getBounds().height ===
          screen.getPrimaryDisplay().workArea.y +
            screen.getPrimaryDisplay().workArea.height
        );
      }),
    )
    .toBe(true);
  expect(await pet.isClosed()).toBe(true);
  await close();
  mark("corrupt-primary");
  // A completed backup must survive an interrupted temporary write and a corrupt primary.
  await session.writeProfileFile("preferences.json", "{broken");
  await session.writeProfileFile("preferences.json.tmp", '{"version":1');
  await launch();
  expect(await visible()).toBe(false);
  await invoke("Show Mosey");
  await expect.poll(visible).toBe(true);
  await close();
  expect(
    JSON.parse(await readFile(path.join(profile, "preferences.json"), "utf8")),
  ).toMatchObject({
    version: 3,
    character: "corgi",
    visibility: "visible",
    size: 240,
  });
  mark("failed-commit");
  // A failed atomic commit must keep the recovered hidden intent and menu choice.
  await session.run("remove-primary", () =>
    rm(path.join(profile, "preferences.json")),
  );
  await session.run("unwritable-primary", () =>
    mkdir(path.join(profile, "preferences.json")),
  );
  await launch();
  expect(await visible()).toBe(false);
  await invoke("Show Mosey");
  expect(await visible()).toBe(false);
  // The menu still offers Show because no durable change succeeded.
  await invoke("Show Mosey");
  await close();
  mark("both-invalid");
  // If neither primary nor backup validates, defaults leave a visible, usable pet.
  await session.run("remove-unwritable-primary", () =>
    rm(path.join(profile, "preferences.json"), { recursive: true }),
  );
  await session.writeProfileFile(
    "preferences.json",
    JSON.stringify({ version: 999, visibility: "hidden" }),
  );
  await session.writeProfileFile("preferences.json.bak", "broken backup");
  const { renderer: recovered } = await launch();
  await expect.poll(visible).toBe(true);
  // Recovery is another cold renderer: load and native visibility can precede
  // atlas decoding. Keep the same first-paint allowance as initial startup.
  await session.run("recovered-paint", () =>
    recovered.waitUntilReady({ paintedPixels: 5000 }),
  );
  const logPath = await evaluate(({ app }) =>
    process.getBuiltinModule("node:path").join(app.getPath("logs"), "main.log"),
  );
  const log = await readFile(logPath, "utf8");
  expect(log).toContain("Invalid pet preferences");
  expect(log).toContain("Unable to save pet visibility");
  expect((await stat(logPath)).size).toBeLessThanOrEqual(1024 * 1024);
  await mkdir("test-results", { recursive: true });
  await writeFile(
    `test-results/${packaged ? "packaged" : "development"}-visibility.json`,
    JSON.stringify(
      {
        idleRendererWorkOver1200Ms: idleWork,
        hiddenRendererWorkBefore: stopped,
        hiddenRendererWorkAfter: afterHidden,
        visibilityRestoredInactive: true,
        launches,
        requestedScale: Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
        sessionEvidence: session.evidence,
        recovery: [
          "corrupt-primary",
          "interrupted-temp",
          "failed-commit",
          "both-invalid",
        ],
        preservedSize: "large",
      },
      null,
      2,
    ),
  );
  await session.quit();
});
