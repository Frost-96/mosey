import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startForge } from "./support/forge";

test.runIf(process.env.MOSEY_TEST_MODE === "development")(
  "loaded hidden startup shows on the exact current ground",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mosey-show-ground-"));
    let app: ElectronApplication | undefined;
    const stop = await startForge();
    const evidence: unknown[] = [];
    try {
      const profile = path.join(root, "profile");
      await mkdir(profile);
      await writeFile(
        path.join(profile, "preferences.json"),
        JSON.stringify({ version: 1, size: "large", visibility: "hidden" }),
      );
      app = await electron.launch({
        args: [
          ".",
          `--user-data-dir=${profile}`,
          "--force-device-scale-factor=1",
        ],
      });
      const pet = await app.firstWindow();
      await pet.waitForLoadState("load");
      const snapshot = () =>
        app!.evaluate(({ BrowserWindow, screen }) => {
          const pet = BrowserWindow.getAllWindows()[0]!;
          const display = screen.getPrimaryDisplay();
          return {
            at: Date.now(),
            bounds: pet.getBounds(),
            visible: pet.isVisible(),
            loading: pet.webContents.isLoading(),
            area: display.workArea,
            scale: display.scaleFactor,
          };
        });
      evidence.push({ event: "loaded-hidden", ...(await snapshot()) });
      await app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "Mosey")
          ?.submenu?.items.find((item) => item.label === "Show Mosey");
        if (!item) throw new Error("Show Mosey missing");
        item.click();
      });
      evidence.push({ event: "show-immediate", ...(await snapshot()) });
      await expect
        .poll(
          () =>
            pet.evaluate(() => {
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
      const shown = await snapshot();
      evidence.push({ event: "visible-pixels", ...shown });
      if (
        shown.bounds.y + shown.bounds.height !==
        shown.area.y + shown.area.height
      ) {
        evidence.push(
          await app.evaluate(({ BrowserWindow, screen }) => {
            const pet = BrowserWindow.getAllWindows()[0]!;
            const before = pet.getBounds();
            const area = screen.getPrimaryDisplay().workArea;
            const requested = {
              x: before.x,
              y: area.y + area.height - before.height,
            };
            pet.setPosition(requested.x, requested.y, false);
            return {
              event: "post-show-position-probe",
              before,
              area,
              requested,
              immediate: pet.getBounds(),
            };
          }),
        );
        evidence.push({ event: "position-next-turn", ...(await snapshot()) });
      }
      expect(shown.bounds.y + shown.bounds.height).toBe(
        shown.area.y + shown.area.height,
      );
    } finally {
      console.error("[DEBUG-hidden-show-ground]", JSON.stringify(evidence));
      await mkdir("test-results", { recursive: true });
      await writeFile(
        "test-results/development-hidden-show-ground.json",
        JSON.stringify(evidence, null, 2),
      );
      await app?.close().catch(() => {});
      await stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
