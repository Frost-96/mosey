import { createPetTestSession } from "./support/pet-session";
import { controlBehavior, advanceRest } from "./support/controlled-behavior";
import { distanceFromGround } from "./support/ground";
import { test, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import { waitForPetVisibility } from "./support/visibility";

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
    const session = await createPetTestSession({
      dock: "empty",
      behavior: {},
      preferences: {
        version: 3,
        character: whale ? "whale" : "corgi",
        size: 240,
        visibility: "visible",
      },
      ...recording,
    });
    const { app, pet } = await session.launch();
    // Vite may finish dependency optimization after the first painted frame.
    await session.run("startup-network-idle", () =>
      pet.waitForLoadState("networkidle"),
    );
    try {
      const menu = async (label: "Hide Mosey" | "Show Mosey") => {
        await session.run("sleep:app-evaluate", () =>
          app.evaluate(({ Menu }, label) => {
            Menu.getApplicationMenu()!
              .items.find((item) => item.label === "Mosey")!
              .submenu!.items.find((item) => item.label === label)!
              .click();
          }, label),
        );
        await waitForPetVisibility(
          app,
          pet,
          label === "Hide Mosey" ? "hidden" : "visible",
          { run: session.run },
        );
      };
      const pixels = () =>
        session.run("sleep:pet-evaluate", () =>
          pet.evaluate(() => {
            const canvas = document.querySelector("canvas")!;
            canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height);
            return canvas.toDataURL();
          }),
        );
      const height = () =>
        session.run("sleep:pet-evaluate", () =>
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
          }),
        );
      await expect.poll(height, { timeout: 5000 }).toBeGreaterThan(180);
      const waitForSleep = async () => {
        // Settling is already short enough to pass the silhouette check, but
        // a click there intentionally wakes immediately. Wait at the renderer
        // contract before exercising the sleeping pet's two-click rule.
        await expect
          .poll(
            () =>
              session.run("sleep:pet-evaluate", () =>
                pet.evaluate(
                  async () => (await window.mosey.getPresentation()).posture,
                ),
              ),
            { timeout: 5500 },
          )
          .toBe("sleeping");
        if (whale) await expect.poll(height).toBeGreaterThan(160);
        else await expect.poll(height).toBeLessThan(160);
      };
      const posture = () =>
        session.run("sleep:pet-evaluate", () =>
          pet.evaluate(
            async () => (await window.mosey.getPresentation()).posture,
          ),
        );
      const waitForVisibleRest = async () => {
        await expect
          .poll(() =>
            session.run("sleep:pet-evaluate", () =>
              pet.evaluate(async () => {
                const current = await window.mosey.getPresentation();
                return (
                  !document.hidden &&
                  current.visibility === "visible" &&
                  current.posture === "resting"
                );
              }),
            ),
          )
          .toBe(true);
      };
      const assertAsleep = async () => {
        expect(["sleeping", "ear"]).toContain(await posture());
        if (whale) expect(await height()).toBeGreaterThan(160);
        else expect(await height()).toBeLessThan(160);
      };
      const assertAwake = async () => {
        await expect
          .poll(async () => idleFrames.has(await pixels()), {
            timeout: 3000,
            interval: 30,
          })
          .toBe(true);
      };
      const idleFrames = new Set<string>();
      const idleUntil = Date.now() + (whale ? 3100 : 2200);
      while (Date.now() < idleUntil) {
        idleFrames.add(await pixels());
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      await session.run("sleep:controlBehavior", () =>
        controlBehavior(app, { random: 0.6 }),
      );
      await menu("Hide Mosey");
      await menu("Show Mosey");
      await waitForVisibleRest();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await session.run("sleep:controlBehavior", () =>
        controlBehavior(app, { advanceBy: 180000 }),
      );
      await advanceRest(app, 0.6, session.run);

      await waitForSleep();
      const mode = evidence;
      const screenshot = (name: string) =>
        session.run("sleep:pet-screenshot", () =>
          pet.screenshot({
            path: `test-results/${mode}-sleep-${name}.png`,
            omitBackground: true,
          }),
        );
      const bounds = () =>
        session.run("sleep:app-evaluate", () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.getBounds(),
          ),
        );
      const enterSleep = async () => {
        await menu("Hide Mosey");
        await menu("Show Mosey");
        await waitForVisibleRest();
        await expect.poll(height).toBeGreaterThan(180);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await session.run("sleep:controlBehavior", () =>
          controlBehavior(app, { advanceBy: 180000 }),
        );
        await advanceRest(app, 0.6, session.run);

        await waitForSleep();
      };
      const sleepingFrames = new Set<string>();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const sleepingUntil = Date.now() + (whale ? 6200 : 2600);
      const sleepingBounds = await bounds();
      while (Date.now() < sleepingUntil) {
        sleepingFrames.add(await pixels());
        await assertAsleep();
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      expect(sleepingFrames.size).toBeGreaterThan(1);
      expect(await bounds()).toEqual(sleepingBounds);
      const body = () =>
        session.run("sleep:pet-evaluate", () =>
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
          }),
        );
      const click = async () => {
        const point = await body();
        await session.run("sleep:pet-mouse-click", () =>
          pet.mouse.click(point.x, point.y),
        );
      };
      await screenshot("breathing");
      await click();
      const firstClickAt = Date.now();
      await expect.poll(posture, { timeout: 250, interval: 10 }).toBe("ear");
      await expect
        .poll(async () => sleepingFrames.has(await pixels()), {
          timeout: 300,
          interval: 10,
        })
        .toBe(false);
      await assertAsleep();
      await click();
      const rapidGap = Date.now() - firstClickAt;
      expect(rapidGap).toBeLessThan(350);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await screenshot("waking");
      await assertAwake();

      // The 500ms ear animation finishes before the 900ms click deadline.
      // Its return to sleeping must still retain the first click.
      await enterSleep();
      await click();
      await new Promise((resolve) => setTimeout(resolve, 650));
      await assertAsleep();
      await click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      await screenshot("standing");
      await assertAwake();

      // A click outside the 900ms window is a new first click, never a wake.
      await enterSleep();
      await click();
      await screenshot("ear");
      await new Promise((resolve) => setTimeout(resolve, 1150));
      await assertAsleep();
      await click();
      const outsideUntil = Date.now() + 1100;
      while (Date.now() < outsideUntil) {
        await assertAsleep();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // Existing context-menu tests cover native popup/cancel. Here retain the
      // menu tracking boundary deterministically: Cocoa can dismiss an inactive
      // automated menu before the requested hold has elapsed.
      await session.run("sleep:app-evaluate", () =>
        app.evaluate(({ Menu }) => {
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
        }),
      );
      await enterSleep();
      const freezeMenu = async () => {
        const point = await body();
        await session.run("sleep:pet-mouse-click", () =>
          pet.mouse.click(point.x, point.y, { button: "right" }),
        );
        await expect
          .poll(() =>
            session.run("sleep:app-evaluate", () =>
              app.evaluate(() => Reflect.get(globalThis, "sleepMenuClosed")),
            ),
          )
          .toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const frozen = await pixels();
        const stationary = await bounds();
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(await pixels()).toBe(frozen);
        expect(await bounds()).toEqual(stationary);
        await session.run("sleep:app-evaluate", () =>
          app.evaluate(({ BrowserWindow }) =>
            Reflect.get(globalThis, "sleepMenu").closePopup(
              BrowserWindow.getAllWindows()[0],
            ),
          ),
        );
      };
      // A secondary click in sleep cannot arm the ordinary two-click window.
      await freezeMenu();
      await click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await assertAsleep();
      const point = await body();
      await session.run("sleep:pet-mouse-click", () =>
        pet.mouse.click(point.x, point.y, { button: "right" }),
      );
      await expect
        .poll(() =>
          session.run("sleep:app-evaluate", () =>
            app.evaluate(() => !!Reflect.get(globalThis, "sleepMenu")),
          ),
        )
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await assertAsleep();
      const frozen = await pixels();
      const stationary = await bounds();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await pixels()).toBe(frozen);
      expect(await bounds()).toEqual(stationary);
      await session.run("sleep:app-evaluate", () =>
        app.evaluate(({ BrowserWindow }) =>
          Reflect.get(globalThis, "sleepMenu").closePopup(
            BrowserWindow.getAllWindows()[0],
          ),
        ),
      );
      await expect
        .poll(() =>
          session.run("sleep:app-evaluate", () =>
            app.evaluate(() => Reflect.get(globalThis, "sleepMenuClosed")),
          ),
        )
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await click();
      await freezeMenu();
      await assertAwake();

      // Sleeping and ear feedback both yield immediately to the existing drag.
      for (const source of ["sleep", "ear", "waking"]) {
        await enterSleep();
        await session.run("sleep:app-evaluate", () =>
          app.evaluate(({ BrowserWindow, screen }) => {
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
          }),
        );
        // Deliver native hover from the old window placement before CDP takes
        // capture; a late native event can cancel the synthetic held pointer.
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (source !== "sleep") await click();
        if (source === "waking") await click();
        const ground = await bounds();
        const point = await body();
        await session.run("sleep:pet-mouse-move", () =>
          pet.mouse.move(point.x, point.y),
        );
        await session.run("sleep:pet-mouse-down", () => pet.mouse.down());
        await session.run("sleep:pet-mouse-move", () =>
          pet.mouse.move(point.x, point.y - 100, { steps: 4 }),
        );
        await expect
          .poll(async () => (await bounds()).y)
          .toBeLessThan(ground.y - 60);
        const grabbed = await bounds();
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect(await bounds()).toEqual(grabbed);
        await session.run("sleep:pet-mouse-up", () => pet.mouse.up());
        await expect
          .poll(
            () =>
              session.run("sleep:distanceFromGround", () =>
                distanceFromGround(app),
              ),
            { timeout: 4000 },
          )
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
      await session.run("sleep:app-evaluate", () =>
        app.evaluate(({ BrowserWindow, screen }) => {
          const pet = BrowserWindow.getAllWindows()[0]!;
          const area = screen.getPrimaryDisplay().workArea;
          pet.setPosition(area.x + 20, pet.getBounds().y, false);
        }),
      );
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
      await session.run("sleep:app-evaluate", () =>
        app.evaluate(({ powerMonitor }) => powerMonitor.emit("suspend")),
      );
      const suspended = await bounds();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await bounds()).toEqual(suspended);
      await session.run("sleep:app-evaluate", () =>
        app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume")),
      );
      await expect.poll(height).toBeGreaterThan(180);
      expect(await bounds()).toEqual(suspended);
      await session.run("sleep:writeFile", () =>
        writeFile(
          `test-results/${mode}-sleep.json`,
          JSON.stringify(
            {
              rapidGapMs: rapidGap,
              sessionEvidence: session.evidence,
              sleepingFrameCount: sleepingFrames.size,
              menuFrozenForMs: 1200,
              dragSources: ["sleep", "ear", "waking"],
              input:
                "Playwright directed window input; native menu tracking intercepted; suspend/resume events simulated",
              timing:
                "controlled behavior adapter advances the awake cycle at rest boundaries; ordinary renderer completion, animation and double-click windows use real elapsed time; infrastructure clocks are unchanged",
            },
            null,
            2,
          ),
        ),
      );
      await session.quit();
    } catch (error) {
      await session
        .run("sleep-failure-screenshot", () =>
          pet.screenshot({
            path: `test-results/failure-${evidence}-sleep.png`,
            timeout: 3000,
          }),
        )
        .catch(() => {});
      throw error;
    }
  },
);
