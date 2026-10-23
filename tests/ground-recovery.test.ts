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
  { size: 240, delta: 10 },
  { size: 110, delta: 1 },
])(
  "$size DIP hide and show follows the current ground after a $delta DIP work-area change",
  async ({ size, delta }) => {
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
      await expect
        .poll(() => page.locator("canvas").getAttribute("width"))
        .not.toBeNull();
      const oldGround = await app.evaluate(({ screen }, size) => {
        const area = screen.getPrimaryDisplay().workArea;
        return area.y + area.height - size;
      }, size);
      const result = await app.evaluate(({ BrowserWindow, screen }, delta) => {
        const display = screen.getPrimaryDisplay();
        screen.getPrimaryDisplay = () => ({
          ...display,
          workArea: {
            ...display.workArea,
            height: display.workArea.height - delta,
          },
        });
        const pet = BrowserWindow.getAllWindows()[0]!;
        pet.hide();
        screen.emit("display-metrics-changed", {}, screen.getPrimaryDisplay(), [
          "workArea",
        ]);
        pet.showInactive();
        return {
          actual: pet.getBounds().y,
          currentGround:
            screen.getPrimaryDisplay().workArea.y +
            screen.getPrimaryDisplay().workArea.height -
            pet.getBounds().height,
        };
      }, delta);
      expect(result.actual).toBe(oldGround - delta);
      expect(result.actual).toBe(result.currentGround);
      await expect.poll(() => distanceFromGround(app!)).toBe(0);
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
