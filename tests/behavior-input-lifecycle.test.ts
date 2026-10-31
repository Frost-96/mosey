import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";

// The inspector may deliver an input before an existing behavior callback
// returns. Reproduce that interleaving at Electron's real IPC publication:
// forward the genuine walking presentation, then submit the next input.
// No actor, timer queue or behavior snapshot is read or substituted.
test("behavior input during an activity publication reaches sleep without advancing a real deadline", async () => {
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
  const elapsed = await session.run("overlapping-behavior-input", () =>
    app.evaluate(
      async (
        { BrowserWindow, screen, powerMonitor, ipcMain, app },
        journal,
      ) => {
        const { appendFileSync } = process.getBuiltinModule("node:fs");
        let events = 0;
        let bytes = 0;
        let exhausted = false;
        const record = (event: string, detail?: unknown) => {
          if (exhausted) return;
          const entry = {
            event,
            at: Date.now(),
            monotonic: performance.now(),
            detail,
          };
          const line = JSON.stringify(entry) + "\n";
          const length = Buffer.byteLength(line);
          // Keep the public trace on failure without unbounded per-frame output.
          // Reserve room for one explicit truncation marker below the 64 KiB cap.
          if (++events > 256 || bytes + length > 63 * 1024) {
            exhausted = true;
            appendFileSync(
              journal,
              JSON.stringify({ event: "trace-limit", at: Date.now() }) + "\n",
            );
            return;
          }
          appendFileSync(journal, line);
          bytes += length;
        };
        // Native lifecycle inputs can interrupt an activity after its input has
        // completed. Record their order alongside real presentation messages.
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
        ipcMain.on("pet:input", (_event, input) => {
          if (input?.type !== "frame") record("pet-input", input);
        });
        const controller = Reflect.get(
          globalThis,
          Symbol.for("mosey.test.behavior"),
        );
        if (!controller)
          throw new Error("Controlled behavior build was not installed");
        const contents = BrowserWindow.getAllWindows().find(
          (window) => window.getTitle() === "Mosey",
        )!.webContents;
        const originalSend = contents.send;
        app.once("before-quit", () => {
          record("before-quit");
          contents.send = originalSend;
          // All observers belong to this process; stop writing before its root
          // can be released by the session after the actual process exit.
          exhausted = true;
        });
        const pet = BrowserWindow.fromWebContents(contents)!;
        pet.on("show", () => record("show"));
        pet.on("hide", () => record("hide"));
        pet.on("unresponsive", () => record("unresponsive"));
        contents.on("did-start-loading", () => record("did-start-loading"));
        contents.on("did-finish-load", () => record("did-finish-load"));
        record("initial-display", screen.getPrimaryDisplay().workArea);
        let injected = false;
        const observations: {
          posture: string;
          actionId: number;
          wall: number;
        }[] = [];
        let nested:
          | Promise<{
              immediately: number;
              wall: number;
              monotonic: number;
              firstWakeup: { wall: number; monotonic: number } | undefined;
            }>
          | undefined;
        contents.send = function (channel, ...args) {
          originalSend.call(this, channel, ...args);
          const presentation = args[0];
          if (!presentation || typeof presentation.posture !== "string") return;
          record("presentation", presentation);
          if (injected) return;
          observations.push({
            posture: presentation.posture,
            actionId: presentation.actionId,
            wall: Date.now(),
          });
          if (presentation.posture !== "walking") return;
          injected = true;
          nested = (async () => {
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
                firstWakeup ??= elapsed;
                const remaining =
                  300 - Math.min(elapsed.wall, elapsed.monotonic);
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
            return {
              immediately,
              firstWakeup,
              wall: Date.now() - wall,
              monotonic: performance.now() - monotonic,
            };
          })();
        };
        try {
          record("advance-requested", 30000);
          await controller.update({ advanceBy: 30000 });
          record("advance-complete", 30000);
          if (!nested)
            throw new Error("The initial activity did not publish walking");
          return { ...(await nested), observations };
        } finally {
          record("input-evaluation-return");
        }
      },
      path.join(session.evidence, "behavior-events.jsonl"),
    ),
  );
  await session.run("record-overlapping-input", () =>
    writeFile(
      path.join(session.evidence, "behavior-input.json"),
      JSON.stringify(elapsed, null, 2),
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
  const frame = await session.run("sleep-paint", () =>
    renderer.waitUntilReady({ paintedPixels: 600 }),
  );
  expect(frame.presentation.posture).toBe("sleeping");
  expect(frame.scaleFactor).toBe(
    Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
  );
  await session.quit();
  await session.close();
});
