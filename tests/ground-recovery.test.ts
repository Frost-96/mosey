import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startForge } from "./support/forge";
import { distanceFromGround } from "./support/ground";
import { execFileSync } from "node:child_process";
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
    const root = await mkdtemp(path.join(os.tmpdir(), "mosey-ground-repro-"));
    let app: ElectronApplication | undefined;
    let stop: (() => Promise<void>) | undefined;
    try {
      await writeFile(
        path.join(root, "preferences.json"),
        JSON.stringify({ version: 2, size, visibility: "visible" }),
      );
      if (!packaged) stop = await startForge();
      else
        execFileSync("/usr/bin/ditto", [
          path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
          path.join(root, "Mosey.app"),
        ]);
      app = await electron.launch(
        packaged
          ? {
              executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
              args: [`--user-data-dir=${root}`],
            }
          : { args: [".", `--user-data-dir=${root}`] },
      );
      const page = await app.firstWindow();
      await page.waitForLoadState("networkidle");
      await expect
        .poll(() => page.locator("canvas").getAttribute("width"))
        .not.toBeNull();
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
        })
        .catch(() => {});
      throw error;
    } finally {
      await app?.close();
      await stop?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);
