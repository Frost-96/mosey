import { emptyDockCapture } from "./support/empty-dock";
import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { startForge } from "./support/forge";
import { distanceFromGround } from "./support/ground";
import { openSettings } from "./support/settings";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

test.each([
  "dragging",
  "falling",
  "hidden",
  "walking",
  "sleeping",
  "preview",
  "main",
])(
  "%s failure preserves the bounded recovery and process lifecycle",
  async (phase) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "mosey-renderer-recovery-"),
    );
    let app: ElectronApplication | undefined;
    let stop: (() => Promise<void>) | undefined;
    let restoreDock: (() => Promise<void>) | undefined;
    try {
      await writeFile(
        path.join(root, "preferences.json"),
        JSON.stringify({
          version: 3,
          character: "corgi",
          size: 240,
          visibility: "visible",
        }),
      );
      if (!packaged) stop = await startForge();
      else
        execFileSync("/usr/bin/ditto", [
          path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
          path.join(root, "Mosey.app"),
        ]);
      restoreDock = await emptyDockCapture(
        packaged
          ? path.join(root, "Mosey.app/Contents/Resources/native/dock-runtime")
          : path.resolve("build/native/dock-runtime"),
      );
      let executablePath = packaged
        ? path.join(root, "Mosey.app/Contents/MacOS/Mosey")
        : undefined;
      if (phase === "main") {
        // macOS records crash/restoration history by bundle ID. Isolate this
        // destructive fault from the developer's Electron and installed Mosey.
        const bundle = packaged
          ? path.join(root, "Mosey.app")
          : path.join(root, "CrashTest.app");
        if (!packaged)
          execFileSync("/usr/bin/ditto", [
            path.resolve("node_modules/electron/dist/Electron.app"),
            bundle,
          ]);
        execFileSync("/usr/libexec/PlistBuddy", [
          "-c",
          `Set :CFBundleIdentifier dev.frost.mosey.fault.${path.basename(root)}`,
          path.join(bundle, "Contents/Info.plist"),
        ]);
        execFileSync("/usr/bin/codesign", [
          "--force",
          "--deep",
          "--sign",
          "-",
          bundle,
        ]);
        executablePath = path.join(
          bundle,
          "Contents/MacOS",
          packaged ? "Mosey" : "Electron",
        );
      }
      app = await electron.launch({
        ...(executablePath ? { executablePath } : {}),
        args: [
          ...(packaged ? [] : ["."]),
          `--user-data-dir=${root}`,
          "-ApplePersistenceIgnoreState",
          "YES",
        ],
      });
      const page = await app.firstWindow();
      // Playwright keeps a crashed Page marked as crashed after Electron reloads
      // the same WebContents. Observe the recovered canvas through Electron's
      // public API instead of depending on that stale driver Page.
      const drawn = () =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().find(
            (window) => window.getTitle() === "Mosey",
          )!.webContents.executeJavaScript(`(() => {
        const canvas = document.querySelector("canvas");
        if (!canvas) return 0;
        return Array.from(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data).filter((value, i) => i % 4 === 3 && value > 127).length;
      })()`),
        );
      // A freshly copied/signed app can decode its first atlas after Vitest's
      // default one-second polling deadline on a cold CI runner.
      await expect.poll(drawn, { timeout: 10000 }).toBeGreaterThan(1500);
      if (phase === "main") {
        const children = await app.evaluate(({ app }) =>
          app
            .getAppMetrics()
            .map((metric) => metric.pid)
            .filter((pid) => pid !== process.pid),
        );
        const processHandle = app.process();
        const exited = app.waitForEvent("close");
        await app.evaluate(() => process.crash()).catch(() => {});
        await exited;
        expect(
          processHandle.exitCode !== 0 || processHandle.signalCode !== null,
        ).toBe(true);
        app = undefined;
        for (const pid of children) {
          await expect
            .poll(
              () => {
                try {
                  process.kill(pid, 0);
                  return false;
                } catch (error) {
                  return (error as NodeJS.ErrnoException).code === "ESRCH";
                }
              },
              { timeout: 10000 },
            )
            .toBe(true);
        }
        return;
      }
      const expectedSize = phase === "preview" ? 200 : 240;
      if (phase === "preview") {
        const settings = await openSettings(app);
        await settings.evaluate(() => window.moseySettings.previewSize(200));
        // Wait for the resized paint before sampling a complete idle cycle.
        // The previous-size canvas can still contain opaque pixels meanwhile.
        await expect
          .poll(() =>
            app!.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()
                .find((window) => window.getTitle() === "Mosey")!
                .webContents.executeJavaScript(
                  'document.querySelector("canvas").width / devicePixelRatio',
                ),
            ),
          )
          .toBe(expectedSize);
        await expect.poll(drawn).toBeGreaterThan(1500);
      }
      const pixels = () =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey")!
            .webContents.executeJavaScript(
              `document.querySelector("canvas").toDataURL()`,
            ),
        );
      const idleFrames = new Set<string>();
      const until = Date.now() + 2200;
      while (Date.now() < until) {
        idleFrames.add(await pixels());
        idleFrames.add(
          await page.evaluate(() => {
            const canvas = document.querySelector("canvas")!;
            const mirror = document.createElement("canvas");
            mirror.width = canvas.width;
            mirror.height = canvas.height;
            const context = mirror.getContext("2d")!;
            context.translate(canvas.width, 0);
            context.scale(-1, 1);
            context.drawImage(canvas, 0, 0);
            return mirror.toDataURL();
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      const references =
        phase === "preview"
          ? [...idleFrames].map((value) =>
              PNG.sync.read(Buffer.from(value.split(",")[1]!, "base64")),
            )
          : [];
      const matchesIdle = (value: string) => {
        if (idleFrames.has(value)) return true;
        if (phase !== "preview") return false;
        const actual = PNG.sync.read(
          Buffer.from(value.split(",")[1]!, "base64"),
        );
        return references.some((reference) => {
          if (
            actual.width !== reference.width ||
            actual.height !== reference.height
          )
            return false;
          let error = 0;
          for (let i = 0; i < actual.data.length; i += 4) {
            const alpha = actual.data[i + 3]!;
            const expectedAlpha = reference.data[i + 3]!;
            error += Math.abs(alpha - expectedAlpha);
            for (let channel = 0; channel < 3; channel++) {
              error += Math.abs(
                (actual.data[i + channel]! * alpha) / 255 -
                  (reference.data[i + channel]! * expectedAlpha) / 255,
              );
            }
          }
          // Noninteger atlas scaling can round differently in a rebuilt Canvas
          // context. Allow under one level per premultiplied RGBA channel;
          // retain exact comparison for the unscaled recovery fixtures.
          return error / actual.data.length < 1;
        });
      };
      const invoke = (label: string) =>
        app!.evaluate(({ Menu }, label) => {
          const item = Menu.getApplicationMenu()!
            .items.find((item) => item.label === "Mosey")!
            .submenu!.items.find((item) => item.label === label);
          if (!item) throw new Error(`Missing menu: ${label}`);
          item.click();
        }, label);
      const visible = () =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey")!
            .isVisible(),
        );
      const crash = () =>
        app!.evaluate(({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows().find(
            (window) => window.getTitle() === "Mosey",
          )!.webContents;
          // The crash request can return before the renderer exits. A snapshot
          // of !isCrashed && !isLoading can then describe the old renderer, and
          // a pixel read sent to it can hang across the subsequent reload.
          // Observe the actual exit before polling the replacement's readiness.
          return new Promise<void>((resolve, reject) => {
            const exited = () => {
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              contents.off("render-process-gone", exited);
              reject(new Error("Renderer did not exit after crash request"));
            }, 5000);
            contents.once("render-process-gone", exited);
            try {
              contents.forcefullyCrashRenderer();
            } catch (error) {
              clearTimeout(timer);
              contents.off("render-process-gone", exited);
              reject(error);
            }
          });
        });
      // Exercise real held and released gestures, plus a hidden renderer.
      if (phase === "hidden") await invoke("Hide Mosey");
      else if (phase === "walking" || phase === "sleeping") {
        // Control time/randomness at the system boundary; never set behavior
        // states or recovery counters. Restore these before the actual fault.
        await app.evaluate(() => {
          const timeout = globalThis.setTimeout;
          const random = Math.random;
          const now = Date.now;
          Reflect.set(globalThis, "restoreRecoveryClock", () => {
            globalThis.setTimeout = timeout;
            Math.random = random;
            Date.now = now;
          });
          Math.random = () => 0.1;
          globalThis.setTimeout = ((
            callback: (...args: unknown[]) => void,
            delay?: number,
            ...args: unknown[]
          ) =>
            timeout(
              callback,
              delay && delay >= 15000 && delay <= 32000 ? 800 : delay,
              ...args,
            )) as typeof setTimeout;
        });
        await invoke("Hide Mosey");
        await invoke("Show Mosey");
        if (phase === "sleeping") {
          await app.evaluate(() => {
            const now = Date.now;
            Date.now = () => now() + 180000;
          });
          await page.evaluate(() => {
            const now = Date.now;
            Date.now = () => now() + 180000;
          });
        }
        await expect
          .poll(async () => idleFrames.has(await pixels()), {
            timeout: 5000,
            interval: 20,
          })
          .toBe(false);
        if (phase === "sleeping")
          await new Promise((resolve) => setTimeout(resolve, 1800));
        await app.evaluate(() =>
          Reflect.get(globalThis, "restoreRecoveryClock")(),
        );
      } else if (phase !== "preview") {
        await page.mouse.move(120, 180);
        await page.mouse.down();
        await page.mouse.move(120, -120);
        await expect.poll(() => distanceFromGround(app!)).not.toBe(0);
        if (phase === "falling") {
          await page.mouse.up();
          const held = await distanceFromGround(app);
          await expect
            .poll(() => distanceFromGround(app!), { interval: 10 })
            .toBeGreaterThan(held + 5);
        }
      }
      await crash();
      await expect
        .poll(() =>
          app!.evaluate(({ BrowserWindow }) => {
            const contents = BrowserWindow.getAllWindows().find(
              (window) => window.getTitle() === "Mosey",
            )!.webContents;
            return !contents.isCrashed() && !contents.isLoading();
          }),
        )
        .toBe(true);
      expect(await visible()).toBe(phase !== "hidden");
      if (phase === "hidden") await invoke("Show Mosey");
      // Load completion precedes asynchronous atlas decoding. Use the same
      // cold-paint allowance as startup, but reject a non-idle first observed
      // frame rather than waiting for a stale action to finish playing.
      await expect.poll(drawn, { timeout: 10000 }).toBeGreaterThan(1500);
      expect(matchesIdle(await pixels())).toBe(true);
      await expect.poll(() => distanceFromGround(app!)).toBe(0);
      // Wait past the interrupted short deadline: no overdue activity or
      // completion may displace the new resting renderer.
      await new Promise((resolve) => setTimeout(resolve, 2600));
      const recoveredPixels = await pixels();
      if (!matchesIdle(recoveredPixels)) {
        await mkdir("test-results", { recursive: true });
        await writeFile(
          `test-results/recovery-${phase}-${packaged ? "packaged" : "development"}.png`,
          Buffer.from(recoveredPixels.split(",")[1]!, "base64"),
        );
        const state = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey")!
            .webContents.executeJavaScript("window.mosey.getPresentation()"),
        );
        throw new Error(
          `Recovered canvas is not resting: ${JSON.stringify(state)}`,
        );
      }
      if (phase === "preview") {
        const presentation = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey")!
            .webContents.executeJavaScript("window.mosey.getPresentation()"),
        );
        expect(presentation.posture).toBe("resting");
        expect(presentation.size).toBe(expectedSize);
      }
      expect(await distanceFromGround(app)).toBe(0);
      expect(
        await app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((window) => window.getTitle() === "Mosey")!
              .getBounds().width,
        ),
      ).toBe(expectedSize);
      await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows().find(
          (window) => window.getTitle() === "Mosey",
        )!.webContents;
        contents.sendInputEvent({
          type: "mouseUp",
          button: "left",
          x: -100,
          y: -100,
        });
        contents.sendInputEvent({ type: "mouseMove", x: -100, y: -100 });
      });
      // No old capture/movement survives the recovered renderer.
      await expect.poll(() => distanceFromGround(app!)).toBe(0);
      await invoke("Hide Mosey");
      await crash();
      await expect
        .poll(() =>
          app!.evaluate(({ Menu }) =>
            Menu.getApplicationMenu()!
              .items.find((item) => item.label === "Mosey")!
              .submenu!.items.some((item) => item.label === "Retry Mosey"),
          ),
        )
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await visible()).toBe(false);
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey")!
            .webContents.isCrashed(),
        ),
      ).toBe(true);
      await invoke("Retry Mosey");
      await expect
        .poll(() =>
          app!.evaluate(({ BrowserWindow }) => {
            const contents = BrowserWindow.getAllWindows().find(
              (window) => window.getTitle() === "Mosey",
            )!.webContents;
            return !contents.isCrashed() && !contents.isLoading();
          }),
        )
        .toBe(true);
      expect(await visible()).toBe(false);
      await invoke("Show Mosey");
      await expect.poll(drawn).toBeGreaterThan(1500);
      await expect.poll(() => distanceFromGround(app!)).toBe(0);
      const logPath = await app.evaluate(({ app }) =>
        process
          .getBuiltinModule("node:path")
          .join(app.getPath("logs"), "main.log"),
      );
      expect(await readFile(logPath, "utf8")).toContain("Pet renderer exited");
      await crash();
      await expect
        .poll(() =>
          app!.evaluate(
            ({ BrowserWindow }) =>
              !BrowserWindow.getAllWindows()
                .find((window) => window.getTitle() === "Mosey")!
                .isVisible(),
          ),
        )
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey")!
            .webContents.isCrashed(),
        ),
      ).toBe(true);
      const exited = app.waitForEvent("close");
      await invoke("Quit Mosey");
      await exited;
      app = undefined;
    } catch (error) {
      await mkdir("test-results", { recursive: true });
      await app
        ?.windows()[0]
        ?.screenshot({
          path: `test-results/failure-recovery-${packaged ? "packaged" : "development"}.png`,
          timeout: 3000,
        })
        .catch(() => {});
      throw error;
    } finally {
      await app?.close().catch(() => {});
      await restoreDock?.();
      await stop?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);
