import { emptyDockCapture } from "./support/empty-dock";
import { distanceFromGround } from "./support/ground";
import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { startForge } from "./support/forge";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
const whale = process.env.MOSEY_TEST_CHARACTER === "whale";
const evidence = `${packaged ? "packaged" : "development"}${whale ? "-whale" : ""}`;
const recording =
  whale && process.env.MOSEY_RECORD_SAMPLE === "1"
    ? {
        recordVideo: {
          dir: "test-results/whale-sleep-video",
          size: { width: 240, height: 240 },
          fps: 60,
        },
      }
    : {};
test(
  "sleep preserves the two-click window, drag priority and lifecycle cancellation",
  { timeout: 120000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mosey-sleep-"));
    let app: ElectronApplication | undefined;
    let stopForge: (() => Promise<void>) | undefined;
    let restoreDockCapture: (() => Promise<void>) | undefined;
    try {
      await mkdir(path.join(root, "profile"), { recursive: true });
      await writeFile(
        path.join(root, "profile/preferences.json"),
        JSON.stringify({
          version: 3,
          character: whale ? "whale" : "corgi",
          size: 240,
          visibility: "visible",
        }),
      );
      if (!packaged) stopForge = await startForge();
      else
        execFileSync("/usr/bin/ditto", [
          path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
          path.join(root, "Mosey.app"),
        ]);
      restoreDockCapture = await emptyDockCapture(
        packaged
          ? path.join(root, "Mosey.app/Contents/Resources/native/dock-runtime")
          : path.resolve("build/native/dock-runtime"),
      );
      app = await electron.launch(
        packaged
          ? {
              executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
              ...recording,
              args: [`--user-data-dir=${root}/profile`],
            }
          : {
              ...recording,
              args: [".", `--user-data-dir=${root}/profile`],
            },
      );
      const pet = await app.firstWindow();
      await pet.waitForLoadState("networkidle");
      const menu = (label: "Hide Mosey" | "Show Mosey") =>
        app!.evaluate(async ({ Menu, BrowserWindow }, label) => {
          const pet = BrowserWindow.getAllWindows()[0]!;
          const event = label === "Hide Mosey" ? "hide" : "show";
          await new Promise<void>((resolve, reject) => {
            const settled = () => {
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              if (event === "hide") pet.removeListener("hide", settled);
              else pet.removeListener("show", settled);
              reject(new Error(`No public ${event} event after ${label}`));
            }, 5000);
            if (event === "hide") pet.once("hide", settled);
            else pet.once("show", settled);
            Menu.getApplicationMenu()!
              .items.find((item) => item.label === "Mosey")!
              .submenu!.items.find((item) => item.label === label)!
              .click();
          });
        }, label);
      const pixels = () =>
        pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height);
          return canvas.toDataURL();
        });
      const height = () =>
        pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let top = canvas.height,
            bottom = -1;
          for (let y = 0; y < canvas.height; y++)
            for (let x = 0; x < canvas.width; x++)
              if (pixels[(y * canvas.width + x) * 4 + 3]! > 127) {
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
              }
          return (bottom - top + 1) / devicePixelRatio;
        });
      await expect.poll(height, { timeout: 5000 }).toBeGreaterThan(180);
      const waitForSleep = async () => {
        // Settling is already short enough to pass the silhouette check, but
        // a click there intentionally wakes immediately. Wait at the renderer
        // contract before exercising the sleeping pet's two-click rule.
        await expect
          .poll(
            () =>
              pet.evaluate(
                async () => (await window.mosey.getPresentation()).posture,
              ),
            { timeout: 3500 },
          )
          .toBe("sleeping");
        await expect.poll(height).toBeLessThan(160);
      };
      const idleFrames = new Set<string>();
      const idleUntil = Date.now() + (whale ? 3100 : 2200);
      while (Date.now() < idleUntil) {
        idleFrames.add(await pixels());
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      await app.evaluate(() => {
        Math.random = () => 0.6;
        const timeout = globalThis.setTimeout;
        globalThis.setTimeout = ((
          callback: (...args: unknown[]) => void,
          delay?: number,
          ...args: unknown[]
        ) =>
          timeout(
            callback,
            delay && delay >= 10000 ? 1200 : delay,
            ...args,
          )) as typeof setTimeout;
      });
      await menu("Hide Mosey");
      await menu("Show Mosey");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await app.evaluate(() => {
        const now = Date.now;
        Date.now = () => now() + 180000;
      });
      await pet.evaluate(() => {
        const now = Date.now;
        Date.now = () => now() + 180000;
      });
      await waitForSleep();
      const mode = evidence;
      await mkdir("test-results", { recursive: true });
      const screenshot = (name: string) =>
        pet.screenshot({
          path: `test-results/${mode}-sleep-${name}.png`,
          omitBackground: true,
        });
      const bounds = () =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.getBounds(),
        );
      const enterSleep = async () => {
        await menu("Hide Mosey");
        await menu("Show Mosey");
        await expect.poll(height).toBeGreaterThan(180);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await app!.evaluate(() => {
          const now = Date.now;
          Date.now = () => now() + 180000;
        });
        await pet.evaluate(() => {
          const now = Date.now;
          Date.now = () => now() + 180000;
        });
        await waitForSleep();
      };
      const sleepingFrames = new Set<string>();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const sleepingUntil = Date.now() + 2600;
      while (Date.now() < sleepingUntil) {
        sleepingFrames.add(await pixels());
        expect(await height()).toBeLessThan(160);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      expect(sleepingFrames.size).toBeGreaterThan(1);
      const body = () =>
        pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          const data = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          const points: { x: number; y: number }[] = [];
          for (let y = 0; y < canvas.height; y++)
            for (let x = 0; x < canvas.width; x++)
              if (data[(y * canvas.width + x) * 4 + 3]! > 200)
                points.push({ x, y });
          const point = points[Math.floor(points.length / 2)]!;
          return {
            x: point.x / devicePixelRatio,
            y: point.y / devicePixelRatio,
          };
        });
      const click = async () => {
        const point = await body();
        await pet.mouse.click(point.x, point.y);
      };
      await screenshot("breathing");
      if (whale) {
        // Synchronize at a newly painted ordinary sleep frame. Its next normal
        // change is 1000ms away, so a short reaction cannot be a coincident tick.
        const previous = await pixels();
        await expect
          .poll(pixels, { timeout: 1500, interval: 10 })
          .not.toBe(previous);
      }
      const beforeFirstClick = await pixels();
      await click();
      const firstClickAt = Date.now();
      if (whale) {
        let previous = beforeFirstClick;
        let transitions = 0;
        await expect
          .poll(
            async () => {
              const current = await pixels();
              if (current !== previous) transitions++;
              previous = current;
              return transitions;
            },
            { timeout: 300, interval: 10 },
          )
          .toBeGreaterThanOrEqual(2);
      } else {
        await expect
          .poll(async () => sleepingFrames.has(await pixels()), {
            timeout: 300,
            interval: 20,
          })
          .toBe(false);
      }
      expect(await height()).toBeLessThan(160);
      await click();
      const rapidGap = Date.now() - firstClickAt;
      expect(rapidGap).toBeLessThan(350);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await screenshot("waking");
      await expect
        .poll(height, { timeout: 2500, interval: 30 })
        .toBeGreaterThan(180);

      // The 500ms ear animation finishes before the 900ms click deadline.
      // Its return to sleeping must still retain the first click.
      await enterSleep();
      await click();
      await new Promise((resolve) => setTimeout(resolve, 650));
      expect(await height()).toBeLessThan(160);
      await click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      await screenshot("standing");
      await expect
        .poll(height, { timeout: 2500, interval: 30 })
        .toBeGreaterThan(180);

      // A click outside the 900ms window is a new first click, never a wake.
      await enterSleep();
      await click();
      await screenshot("ear");
      await new Promise((resolve) => setTimeout(resolve, 1150));
      expect(await height()).toBeLessThan(160);
      await click();
      const outsideUntil = Date.now() + 1100;
      while (Date.now() < outsideUntil) {
        expect(await height()).toBeLessThan(160);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // Existing context-menu tests cover native popup/cancel. Here retain the
      // menu tracking boundary deterministically: Cocoa can dismiss an inactive
      // automated menu before the requested hold has elapsed.
      await app.evaluate(({ Menu }) => {
        Menu.prototype.popup = function (options) {
          Reflect.set(globalThis, "sleepMenu", this);
          Reflect.set(globalThis, "sleepMenuClosed", false);
          Reflect.set(this, "trackingCallback", options?.callback);
          this.emit("menu-will-show");
        };
        Menu.prototype.closePopup = function () {
          this.emit("menu-will-close");
          Reflect.set(globalThis, "sleepMenuClosed", true);
          const callback = Reflect.get(this, "trackingCallback");
          Reflect.set(this, "trackingCallback", undefined);
          callback?.();
        };
      });
      await enterSleep();
      const freezeMenu = async () => {
        const point = await body();
        await pet.mouse.click(point.x, point.y, { button: "right" });
        await expect
          .poll(() =>
            app!.evaluate(() => Reflect.get(globalThis, "sleepMenuClosed")),
          )
          .toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const frozen = await pixels();
        const stationary = await bounds();
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(await pixels()).toBe(frozen);
        expect(await bounds()).toEqual(stationary);
        await app!.evaluate(({ BrowserWindow }) =>
          Reflect.get(globalThis, "sleepMenu").closePopup(
            BrowserWindow.getAllWindows()[0],
          ),
        );
      };
      // A secondary click in sleep cannot arm the ordinary two-click window.
      await freezeMenu();
      await click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(await height()).toBeLessThan(160);
      const point = await body();
      await pet.mouse.click(point.x, point.y, { button: "right" });
      await expect
        .poll(() => app!.evaluate(() => !!Reflect.get(globalThis, "sleepMenu")))
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await height()).toBeLessThan(160);
      const frozen = await pixels();
      const stationary = await bounds();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await pixels()).toBe(frozen);
      expect(await bounds()).toEqual(stationary);
      await app.evaluate(({ BrowserWindow }) =>
        Reflect.get(globalThis, "sleepMenu").closePopup(
          BrowserWindow.getAllWindows()[0],
        ),
      );
      await expect
        .poll(() =>
          app!.evaluate(() => Reflect.get(globalThis, "sleepMenuClosed")),
        )
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await click();
      await freezeMenu();
      await expect
        .poll(height, { timeout: 2500, interval: 30 })
        .toBeGreaterThan(180);

      // Sleeping and ear feedback both yield immediately to the existing drag.
      for (const source of ["sleep", "ear", "waking"]) {
        await enterSleep();
        await app.evaluate(({ BrowserWindow, screen }) => {
          const pet = BrowserWindow.getAllWindows()[0]!;
          const area = screen.getPrimaryDisplay().workArea;
          const cursor = screen.getCursorScreenPoint();
          pet.setPosition(
            cursor.x >= area.x + area.width / 2
              ? area.x
              : area.x + area.width - pet.getBounds().width,
            pet.getBounds().y,
            false,
          );
        });
        // Deliver native hover from the old window placement before CDP takes
        // capture; a late native event can cancel the synthetic held pointer.
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (source !== "sleep") await click();
        if (source === "waking") await click();
        const ground = await bounds();
        const point = await body();
        await pet.mouse.move(point.x, point.y);
        await pet.mouse.down();
        await pet.mouse.move(point.x, point.y - 100, { steps: 4 });
        await expect
          .poll(async () => (await bounds()).y)
          .toBeLessThan(ground.y - 60);
        const grabbed = await bounds();
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect(await bounds()).toEqual(grabbed);
        await pet.mouse.up();
        await expect
          .poll(() => distanceFromGround(app!), { timeout: 4000 })
          .toBe(0);
        await expect
          .poll(async () => idleFrames.has(await pixels()), { timeout: 4000 })
          .toBe(true);
        // Release must return to quiet rest rather than queue a teasing reaction.
        const landed = await bounds();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(await bounds()).toEqual(landed);
        expect(idleFrames.has(await pixels())).toBe(true);
      }

      await enterSleep();
      await app.evaluate(({ BrowserWindow, screen }) => {
        const pet = BrowserWindow.getAllWindows()[0]!;
        const area = screen.getPrimaryDisplay().workArea;
        pet.setPosition(area.x + 20, pet.getBounds().y, false);
      });
      const beforeHide = await bounds();
      await click();
      await menu("Hide Mosey");
      const hidden = await bounds();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await bounds()).toEqual(hidden);
      await menu("Show Mosey");
      await expect.poll(height).toBeGreaterThan(180);
      const restored = await bounds();
      expect(restored).toEqual(beforeHide);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await bounds()).toEqual(restored);

      await enterSleep();
      await click();
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit("suspend"));
      const suspended = await bounds();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await bounds()).toEqual(suspended);
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
      await expect.poll(height).toBeGreaterThan(180);
      expect(await bounds()).toEqual(suspended);
      await writeFile(
        `test-results/${mode}-sleep.json`,
        JSON.stringify(
          {
            rapidGapMs: rapidGap,
            sleepingFrameCount: sleepingFrames.size,
            menuFrozenForMs: 1200,
            dragSources: ["sleep", "ear", "waking"],
            input:
              "Playwright directed window input; native menu tracking intercepted; suspend/resume events simulated",
            timing:
              "long rest delays shortened to1200ms; active lifespan advanced180s at external Date.now boundary; sleep entry synchronized through renderer contract; frames and click windows use real elapsed time",
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await mkdir("test-results", { recursive: true });
      await app
        ?.windows()[0]
        ?.screenshot({
          path: `test-results/failure-${evidence}-sleep.png`,
        })
        .catch(() => {});
      throw error;
    } finally {
      await app?.close().catch(() => {});
      await restoreDockCapture?.();
      await stopForge?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);
