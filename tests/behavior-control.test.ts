import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";

// Application wiring and real deadlines are observed in the actual Electron
// process. The control object supplies inputs; all pet assertions use IPC/paint.
test("controlled behavior reaches sleep without advancing an unrelated real deadline", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    behavior: { random: 0.1 },
    preferences: {
      version: 3,
      character: "corgi",
      size: 160,
      visibility: "visible",
    },
  });
  const { app, renderer } = await session.launch();
  const before = await session.run(
    "initial-behavior-paint",
    () => renderer.waitUntilReady({ paintedPixels: 600 }),
    { timeout: 10000 },
  );
  const elapsed = await session.run(
    "real-deadline-during-behavior-advance",
    () =>
      app.evaluate(
        async (
          { BrowserWindow, screen, powerMonitor, ipcMain, app },
          journal,
        ) => {
          // Preserve public observations if the later sleep assertion fails.
          // Synchronous writes can affect scheduling; this trace is diagnostic.
          const { appendFileSync } = process.getBuiltinModule("node:fs");
          let entries = 0;
          let bytes = 0;
          let stopped = false;
          const record = (event: string, detail?: unknown) => {
            if (stopped) return;
            const line =
              JSON.stringify({
                event,
                at: Date.now(),
                monotonic: performance.now(),
                detail,
              }) + "\n";
            const length = Buffer.byteLength(line);
            // Match the lifecycle trace bound, with room for the limit marker.
            if (++entries > 256 || bytes + length > 63 * 1024) {
              stopped = true;
              appendFileSync(
                journal,
                JSON.stringify({ event: "trace-limit", at: Date.now() }) + "\n",
              );
              return;
            }
            appendFileSync(journal, line);
            bytes += length;
          };
          const pet = BrowserWindow.getAllWindows().find(
            (window) => window.getTitle() === "Mosey",
          )!;
          const contents = pet.webContents;
          const originalSend = contents.send;
          contents.send = function (channel, ...args) {
            originalSend.call(this, channel, ...args);
            if (
              channel === "pet:presentation" ||
              channel === "pet:gesture-cancellation"
            )
              record(channel, args[0]);
          };
          // Bracket the installed application handlers. Publications are logged
          // after forwarding; these timestamps describe observer execution order.
          ipcMain.prependListener("pet:input", (_event, input) =>
            record("input-arrived", input),
          );
          ipcMain.on("pet:input", (_event, input) =>
            record("input-handled", input),
          );
          screen.on("display-metrics-changed", (_event, display, metrics) =>
            record("display-metrics-changed", {
              metrics,
              workArea: display.workArea,
            }),
          );
          screen.on("display-added", (_event, display) =>
            record("display-added", display.workArea),
          );
          screen.on("display-removed", (_event, display) =>
            record("display-removed", display.workArea),
          );
          powerMonitor.on("resume", () => record("resume"));
          powerMonitor.on("suspend", () => record("suspend"));
          powerMonitor.on("unlock-screen", () => record("unlock-screen"));
          powerMonitor.on("lock-screen", () => record("lock-screen"));
          pet.on("move", () => record("move", pet.getBounds()));
          pet.on("resize", () => record("resize", pet.getBounds()));
          pet.on("show", () => record("show"));
          pet.on("hide", () => record("hide"));
          pet.on("focus", () => record("focus"));
          pet.on("blur", () => record("blur"));
          pet.on("unresponsive", () => record("unresponsive"));
          contents.on("did-start-loading", () => record("did-start-loading"));
          contents.on("did-finish-load", () => record("did-finish-load"));
          contents.on("render-process-gone", (_event, details) =>
            record("render-process-gone", details),
          );
          app.once("before-quit", () => {
            record("before-quit");
            contents.send = originalSend;
            stopped = true;
          });
          record("initial-window", {
            bounds: pet.getBounds(),
            visible: pet.isVisible(),
            workArea: screen.getPrimaryDisplay().workArea,
          });
          const controller = Reflect.get(
            globalThis,
            Symbol.for("mosey.test.behavior"),
          );
          if (!controller)
            throw new Error("Controlled behavior build was not installed");
          const wall = Date.now();
          const monotonic = performance.now();
          let firstWakeup: { wall: number; monotonic: number } | undefined;
          const timeout = new Promise<void>((resolve) => {
            // A timer callback can arrive before its nominal delay. Keep the
            // deadline at 300 real milliseconds; only rearm its remaining time.
            const check = () => {
              const elapsed = {
                wall: Date.now() - wall,
                monotonic: performance.now() - monotonic,
              };
              record("deadline-wakeup", elapsed);
              firstWakeup ??= elapsed;
              const remaining = 300 - Math.min(elapsed.wall, elapsed.monotonic);
              if (remaining > 0) setTimeout(check, remaining);
              else resolve();
            };
            setTimeout(check, 300);
          });
          record("advance-requested", 180000);
          await controller.update({ advanceBy: 180000 });
          record("advance-complete", 180000);
          const immediately = Date.now() - wall;
          await timeout;
          record("input-evaluation-return");
          return {
            immediately,
            firstWakeup,
            wall: Date.now() - wall,
            monotonic: performance.now() - monotonic,
          };
        },
        path.join(session.evidence, "behavior-third-events.jsonl"),
      ),
  );
  const after = await session.run(
    "advanced-behavior-presentation",
    renderer.read,
  );
  // Preserve public observations before an assertion can fail. The original CI
  // failure retained neither the input timing nor the pre-advance posture.
  await session.run("record-behavior-input", () =>
    writeFile(
      path.join(session.evidence, "behavior-input.json"),
      JSON.stringify(
        { elapsed, before: before.presentation, after: after?.presentation },
        null,
        2,
      ),
    ),
  );
  expect(elapsed.immediately).toBeLessThan(300);
  expect(elapsed.wall).toBeGreaterThanOrEqual(300);
  expect(elapsed.monotonic).toBeGreaterThanOrEqual(300);
  expect(Math.abs(elapsed.wall - elapsed.monotonic)).toBeLessThan(50);
  await expect
    .poll(
      async () =>
        (await session.run("sleep-presentation", renderer.read))?.presentation
          .posture,
    )
    .toBe("sleeping");
  const frame = await session.run(
    "behavior-paint",
    () => renderer.waitUntilReady({ paintedPixels: 600 }),
    { timeout: 10000 },
  );
  expect(frame.presentation.posture).toBe("sleeping");
  expect(frame.scaleFactor).toBe(
    Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
  );
  await session.run("record-behavior-deadline", () =>
    writeFile(
      path.join(session.evidence, "behavior-deadline.json"),
      JSON.stringify(
        {
          elapsed,
          requestedScale: Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
          observedScale: frame.scaleFactor,
          posture: frame.presentation.posture,
        },
        null,
        2,
      ),
    ),
  );
  await session.quit();
  await session.close();
});

test("production-default application paints without a behavior controller", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      size: 160,
      visibility: "visible",
    },
  });
  const { app, renderer } = await session.launch();
  expect(
    await session.run("production-controller-absent", () =>
      app.evaluate(() =>
        Reflect.has(globalThis, Symbol.for("mosey.test.behavior")),
      ),
    ),
  ).toBe(false);
  const frame = await session.run(
    "behavior-paint",
    () => renderer.waitUntilReady({ paintedPixels: 600 }),
    { timeout: 10000 },
  );
  expect(frame.presentation.posture).toBe("resting");
  expect(frame.scaleFactor).toBe(
    Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
  );
  await session.quit();
  await session.close();
});
