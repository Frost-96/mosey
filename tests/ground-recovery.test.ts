import { test, expect } from "vitest";
import type { ElectronApplication } from "playwright";
import { distanceFromGround } from "./support/ground";
import { createPetTestSession } from "./support/pet-session";
const packaged = process.env.MOSEY_TEST_MODE === "packaged";

test.each([
  { size: 240, delta: 10, notifyMetrics: true },
  { size: 110, delta: 1, notifyMetrics: true },
  { size: 240, delta: 1, notifyMetrics: false },
  { size: 240, delta: -1, notifyMetrics: false },
  { size: 110, delta: 1, notifyMetrics: false },
])(
  "$size DIP follows a $delta DIP work-area change (metrics notification: $notifyMetrics)",
  async ({ size, delta, notifyMetrics }) => {
    const session = await createPetTestSession({
      dock: "real",
      preferences: {
        version: 3,
        character: "corgi",
        size,
        visibility: "visible",
      },
    });
    let app: ElectronApplication | undefined;
    try {
      const launched = await session.launch();
      app = launched.app;
      const page = launched.pet;
      await page.waitForLoadState("networkidle");
      await expect
        .poll(() => page.locator("canvas").getAttribute("width"))
        .not.toBeNull();
      session.mark("work-area-change");
      const result = await app.evaluate(
        ({ BrowserWindow, screen }, { delta, notifyMetrics }) => {
          const pet = BrowserWindow.getAllWindows()[0]!;
          const display = screen.getPrimaryDisplay();
          screen.getPrimaryDisplay = () => ({
            ...display,
            workArea: {
              ...display.workArea,
              height: display.workArea.height - delta,
            },
          });
          if (notifyMetrics) {
            pet.hide();
            screen.emit(
              "display-metrics-changed",
              {},
              screen.getPrimaryDisplay(),
              ["workArea"],
            );
          }
          if (notifyMetrics) pet.showInactive();
          return {
            initialGround:
              display.workArea.y +
              display.workArea.height -
              pet.getBounds().height,
            actual: pet.getBounds().y,
            currentGround:
              screen.getPrimaryDisplay().workArea.y +
              screen.getPrimaryDisplay().workArea.height -
              pet.getBounds().height,
          };
        },
        { delta, notifyMetrics },
      );
      session.mark("ground-recovery");
      if (!notifyMetrics) {
        // The screen boundary exposes a new work area before its native
        // notification. Observe recovery against the live floor, not a stale y.
        await expect
          .poll(() => distanceFromGround(app!), { timeout: 1000 })
          .toBe(0);
        const actual = await app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.getBounds().y,
        );
        expect(actual).toBe(result.initialGround - delta);
        expect(actual).toBe(result.currentGround);
      } else {
        expect(result.actual).toBe(result.initialGround - delta);
        expect(result.actual).toBe(result.currentGround);
        await expect.poll(() => distanceFromGround(app!)).toBe(0);
      }
    } catch (error) {
      await app
        ?.windows()[0]
        ?.screenshot({
          path: `test-results/failure-ground-${packaged ? "packaged" : "development"}.png`,
          timeout: 3000,
        })
        .catch(() => {});
      throw error;
    } finally {
      await session.close();
    }
  },
);
