import { test, expect } from "vitest";
import { createPetTestSession } from "./support/pet-session";
import { distanceFromGround } from "./support/ground";

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
      dock: "empty",
      preferences: {
        version: 3,
        character: "corgi",
        size,
        visibility: "visible",
      },
    });
    const { app, pet: page } = await session.launch();
    const ratio = Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1");
    const raster = await session.run("page-evaluate", () =>
      page.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = 0;
        for (let i = 3; i < pixels.length; i += 4)
          if (pixels[i] > 127) opaque++;
        return {
          ratio: devicePixelRatio,
          width: canvas.width,
          height: canvas.height,
          cssWidth: canvas.getBoundingClientRect().width,
          cssHeight: canvas.getBoundingClientRect().height,
          opaque,
        };
      }),
    );
    expect(raster).toMatchObject({
      ratio,
      width: size * ratio,
      height: size * ratio,
      cssWidth: size,
      cssHeight: size,
    });
    expect(raster.opaque).toBeGreaterThan(size * size * ratio * ratio * 0.2);
    const result = await session.run("app-evaluate", () =>
      app.evaluate(
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
      ),
    );
    if (!notifyMetrics) {
      // The screen boundary exposes a new work area before its native
      // notification. Observe recovery against the live floor, not a stale y.
      await expect
        .poll(
          () =>
            session.run("distanceFromGround", () => distanceFromGround(app)),
          { timeout: 1000 },
        )
        .toBe(0);
      const actual = await session.run("app-evaluate", () =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.getBounds().y,
        ),
      );
      expect(actual).toBe(result.initialGround - delta);
      expect(actual).toBe(result.currentGround);
    } else {
      expect(result.actual).toBe(result.initialGround - delta);
      expect(result.actual).toBe(result.currentGround);
      await expect
        .poll(() =>
          session.run("distanceFromGround", () => distanceFromGround(app)),
        )
        .toBe(0);
    }
  },
);
