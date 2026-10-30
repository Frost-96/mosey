import { controlBehavior, advanceRest } from "./support/controlled-behavior";
import { expect, test } from "vitest";
import type { Page } from "playwright";
import { readFile } from "node:fs/promises";
import {
  createPetTestSession,
  type SessionOperation,
} from "./support/pet-session";
import { openSettings } from "./support/settings";

const scaleFactor = process.env.MOSEY_TEST_SCALE_FACTOR ?? "1";

// Observe the real Canvas, independently of atlas metadata and the production
// geometry. Select interiors with a margin so antialiasing is not the oracle.
async function paintedPoints(pet: Page, run: SessionOperation) {
  const points = await run("pet-evaluate", () =>
    pet.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const pixels = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      const alpha = (x: number, y: number) =>
        pixels[(y * canvas.width + x) * 4 + 3]!;
      const radius = Math.ceil(2 * devicePixelRatio);
      let body: { x: number; y: number } | undefined;
      let transparent: { x: number; y: number } | undefined;
      let bottom = 0;
      for (let y = radius; y < canvas.height - radius; y++) {
        for (let x = radius; x < canvas.width - radius; x++) {
          if (body && transparent) break;
          const opaque = alpha(x, y) > 250;
          if (opaque ? body : transparent) continue;
          if (opaque && (y < canvas.height * 0.55 || y > canvas.height * 0.85))
            continue;
          let interior = true;
          for (let dy = -radius; dy <= radius && interior; dy++)
            for (let dx = -radius; dx <= radius; dx++)
              if (
                opaque ? alpha(x + dx, y + dy) < 250 : alpha(x + dx, y + dy)
              ) {
                interior = false;
                break;
              }
          if (!interior) continue;
          const point = {
            x: (x + 0.5) / devicePixelRatio,
            y: (y + 0.5) / devicePixelRatio,
          };
          if (opaque) body = point;
          else transparent = point;
        }
      }
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++)
          if (alpha(x, y) >= 128) bottom = y + 1;
      return {
        body,
        transparent,
        bottom: bottom / devicePixelRatio,
        side: canvas.width / devicePixelRatio,
        ratio: devicePixelRatio,
      };
    }),
  );
  // A valid transport can observe the canvas between clearing and painting.
  // Keep that readiness assertion outside the cancellation boundary so the
  // caller's existing bounded poll can wait for its required pixels.
  const { body, transparent } = points;
  if (!body || !transparent)
    throw new Error("Missing painted/transparent interior");
  return { ...points, body, transparent };
}

for (const character of ["corgi", "whale"] as const) {
  for (const direction of ["right", "left"] as const) {
    test(`${character} ${direction} preserves painted input and feet at every preset size (${scaleFactor}x)`, async () => {
      const session = await createPetTestSession({
        dock: "empty",
        ...(direction === "left" ? { behavior: { random: 0.1 } } : {}),
        scaleFactor,
        preferences: { version: 3, character, size: 160, visibility: "hidden" },
      });
      const { app, pet } = await session.launch();
      const settings = await openSettings(app, { run: session.run });
      const native = () =>
        session.run("app-evaluate", () =>
          app.evaluate(({ BrowserWindow, screen }) => ({
            bounds: BrowserWindow.getAllWindows()
              .find((window) => window.getTitle() === "Mosey")!
              .getBounds(),
            area: screen.getPrimaryDisplay().workArea,
          })),
        );
      // Only the left-facing scenario controls behavior input. The right
      // facing path retains the production-default adapter.
      await session.run("settings-click", () =>
        settings.getByRole("button", { name: "显示宠物", exact: true }).click(),
      );
      if (direction === "left") {
        await advanceRest(app, 0.1, session.run);
        let points: Awaited<ReturnType<typeof paintedPoints>> | undefined;
        await expect
          .poll(async () => {
            const presentation = await session.run("pet-evaluate", () =>
              pet.evaluate(() => window.mosey.getPresentation()),
            );
            // Publication can precede its first animation frame. Keep the
            // original walking budget while waiting for the required hit area.
            if (presentation.posture === "walking")
              points = await paintedPoints(pet, session.run);
            return presentation.posture;
          })
          .toBe("walking");
        if (!points) throw new Error("Walking did not produce a painted body");
        const { body } = points;
        await session.run("pet-click", () => pet.mouse.click(body.x, body.y));
      }
      await expect
        .poll(
          async () =>
            (
              await session.run("pet-evaluate", () =>
                pet.evaluate(() => window.mosey.getPresentation()),
              )
            ).posture,
          { timeout: 5000 },
        )
        .toBe("resting");
      // Keep the native cursor clear of synthetic gestures and leave enough
      // room for every size, so work-area clamping cannot move the foot.
      await session.run("app-evaluate", () =>
        app.evaluate(({ BrowserWindow, screen }) => {
          const window = BrowserWindow.getAllWindows().find(
            (entry) => entry.getTitle() === "Mosey",
          )!;
          const area = screen.getPrimaryDisplay().workArea;
          const fraction =
            screen.getCursorScreenPoint().x > area.x + area.width / 2
              ? 0.25
              : 0.75;
          window.setPosition(
            Math.round(area.x + area.width * fraction - 80),
            area.y + area.height - 160,
            false,
          );
        }),
      );
      for (const size of [160, 70, 240]) {
        const before = (await native()).bounds;
        await session.run("settings-evaluate", () =>
          settings.evaluate((size) => window.moseySettings.setSize(size), size),
        );
        await expect
          .poll(async () => (await paintedPoints(pet, session.run)).side)
          .toBe(size);
        const points = await paintedPoints(pet, session.run);
        expect(points.ratio).toBe(Number(scaleFactor));
        expect(points.bottom).toBeGreaterThanOrEqual(size - 3);
        expect(points.bottom).toBeLessThanOrEqual(size);
        const current = await native();
        const ground = current.bounds;
        expect(ground.x + ground.width / 2).toBe(before.x + before.width / 2);
        expect(ground.y + ground.height).toBe(
          current.area.y + current.area.height,
        );
        expect(
          (
            await session.run("pet-evaluate", () =>
              pet.evaluate(() => window.mosey.getPresentation()),
            )
          ).direction,
        ).toBe(direction);

        await session.run("pet-move", () =>
          pet.mouse.move(points.transparent.x, points.transparent.y),
        );
        await session.run("pet-down", () => pet.mouse.down());
        await session.run("pet-move", () =>
          pet.mouse.move(points.transparent.x, points.transparent.y - 60),
        );
        await session.run("pet-up", () => pet.mouse.up());
        expect((await native()).bounds).toEqual(ground);
        expect(
          (
            await session.run("pet-evaluate", () =>
              pet.evaluate(() => window.mosey.getPresentation()),
            )
          ).posture,
        ).toBe("resting");

        const { body } = await paintedPoints(pet, session.run);
        await session.run("pet-move", () => pet.mouse.move(body.x, body.y));
        await session.run("pet-down", () => pet.mouse.down());
        await session.run("pet-move", () =>
          pet.mouse.move(body.x, body.y - 60),
        );
        await expect
          .poll(async () => (await native()).bounds.y)
          .toBeLessThan(ground.y - 40);
        await session.run("pet-up", () => pet.mouse.up());
        await expect.poll(async () => (await native()).bounds).toEqual(ground);
        await expect
          .poll(
            async () =>
              (
                await session.run("pet-evaluate", () =>
                  pet.evaluate(() => window.mosey.getPresentation()),
                )
              ).posture,
          )
          .toBe("resting");
      }
    });
  }
}

test("retired frames cannot restore input after size or character changes before a new paint", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    scaleFactor,
    preferences: {
      version: 3,
      character: "whale",
      size: 160,
      visibility: "visible",
    },
  });
  const { app, pet } = await session.launch();
  const settings = await openSettings(app, { run: session.run });
  const bounds = () =>
    session.run("app-evaluate", () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Mosey")!
          .getBounds(),
      ),
    );
  for (const change of ["size", "character"] as const) {
    const { body } = await paintedPoints(pet, session.run);
    const old = await session.run("pet-evaluate", () =>
      pet.evaluate(async () => {
        // Animation scheduling is an external browser boundary. Keep the real
        // last image on screen while the settings/IPC lifecycle advances.
        const original = window.requestAnimationFrame;
        Reflect.set(window, "resumeGeometryDrawing", () => {
          window.requestAnimationFrame = original;
          window.dispatchEvent(new Event("resize"));
        });
        window.requestAnimationFrame = () => 0;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return window.mosey.getPresentation();
      }),
    );
    if (change === "size") {
      await session.run("settings-evaluate", () =>
        settings.evaluate(() => window.moseySettings.setSize(70)),
      );
      await session.run("settings-evaluate", () =>
        settings.evaluate(() => window.moseySettings.setSize(160)),
      );
    } else {
      await session.run("settings-evaluate", () =>
        settings.evaluate(() => window.moseySettings.setCharacter("corgi")),
      );
      await expect
        .poll(
          async () =>
            (
              await session.run("pet-evaluate", () =>
                pet.evaluate(() => window.mosey.getPresentation()),
              )
            ).character,
        )
        .toBe("corgi");
      await session.run("settings-evaluate", () =>
        settings.evaluate(() => window.moseySettings.setCharacter("whale")),
      );
      await expect
        .poll(
          async () =>
            (
              await session.run("pet-evaluate", () =>
                pet.evaluate(() => window.mosey.getPresentation()),
              )
            ).character,
        )
        .toBe("whale");
    }
    // Return to the same shape/size so the observed old body point would be
    // grabbable if a delayed frame incorrectly re-enabled the retired mask.
    const current = await session.run("pet-evaluate", () =>
      pet.evaluate(() => window.mosey.getPresentation()),
    );
    expect(current.geometryRevision).toBeGreaterThan(old.geometryRevision);
    const before = await bounds();
    await session.run("pet-evaluate", () =>
      pet.evaluate(
        ({ old, body, current }) => {
          window.mosey.input({
            type: "frame",
            geometryRevision: old.geometryRevision,
            actionId: old.actionId,
            frame: 0,
          });
          window.mosey.input({
            type: "press",
            geometryRevision: current.geometryRevision,
            actionId: current.actionId,
            gestureId: 901,
            ...body,
            screenX: 500,
            screenY: 500,
          });
          window.mosey.input({
            type: "move",
            gestureId: 901,
            screenX: 500,
            screenY: 440,
          });
          window.mosey.input({ type: "release", gestureId: 901 });
        },
        { old, body, current },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await bounds()).toEqual(before);
    expect(
      (
        await session.run("pet-evaluate", () =>
          pet.evaluate(() => window.mosey.getPresentation()),
        )
      ).posture,
    ).toBe("resting");
    await session.run("pet-evaluate", () =>
      pet.evaluate(() => Reflect.get(window, "resumeGeometryDrawing")()),
    );
    // Wait for a real frame callback, then prove the same public input can
    // grab the freshly painted body, ruling out an always-disabled hit mask.
    await session.run("pet-evaluate", () =>
      pet.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      ),
    );
    const next = await paintedPoints(pet, session.run);
    await session.run("pet-move", () =>
      pet.mouse.move(next.body.x, next.body.y),
    );
    await session.run("pet-down", () => pet.mouse.down());
    await session.run("pet-move", () =>
      pet.mouse.move(next.body.x, next.body.y - 60),
    );
    await expect
      .poll(async () => (await bounds()).y)
      .toBeLessThan(before.y - 40);
    await session.run("pet-up", () => pet.mouse.up());
    await expect.poll(bounds).toEqual(before);
    await expect
      .poll(
        async () =>
          (
            await session.run("pet-evaluate", () =>
              pet.evaluate(() => window.mosey.getPresentation()),
            )
          ).posture,
      )
      .toBe("resting");
  }
});

test("left-facing sleep retains authored lettering and mirrored alpha geometry", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    behavior: { random: 0.1 },
    scaleFactor: "2",
    preferences: {
      version: 3,
      character: "whale",
      size: 240,
      visibility: "hidden",
    },
  });
  const { app, pet } = await session.launch();
  const settings = await openSettings(app, { run: session.run });

  await session.run("settings-click", () =>
    settings.getByRole("button", { name: "显示宠物", exact: true }).click(),
  );
  await advanceRest(app, 0.1, session.run);
  await expect
    .poll(
      async () =>
        (
          await session.run("pet-evaluate", () =>
            pet.evaluate(() => window.mosey.getPresentation()),
          )
        ).posture,
      { timeout: 5000 },
    )
    .toBe("walking");
  expect(
    (
      await session.run("pet-evaluate", () =>
        pet.evaluate(() => window.mosey.getPresentation()),
      )
    ).direction,
  ).toBe("left");
  await session.run("app-evaluate", () =>
    app.evaluate(({ Menu }) => {
      for (const label of ["Hide Mosey", "Show Mosey"])
        Menu.getApplicationMenu()!
          .items.find((item) => item.label === "Mosey")!
          .submenu!.items.find((item) => item.label === label)!
          .click();
    }),
  );
  await expect
    .poll(
      async () =>
        (
          await session.run("pet-evaluate", () =>
            pet.evaluate(() => window.mosey.getPresentation()),
          )
        ).posture,
    )
    .toBe("resting");
  await session.run("controlBehavior", () =>
    controlBehavior(app, { advanceBy: 180000 }),
  );

  await expect
    .poll(
      async () =>
        (
          await session.run("pet-evaluate", () =>
            pet.evaluate(() => window.mosey.getPresentation()),
          )
        ).posture,
      { timeout: 6000 },
    )
    .toBe("sleeping");
  const sources = await Promise.all(
    ["sleeping-atlas-left.png", "sleeping-atlas.png"].map(
      async (file) =>
        `data:image/png;base64,${(await session.run("readFile", () => readFile(`src/assets/generated/whale/${file}`))).toString("base64")}`,
    ),
  );
  const compared = await session.run("pet-evaluate", () =>
    pet.evaluate(async (sources) => {
      const images = await Promise.all(
        sources.map(async (source) => {
          const image = new Image();
          image.src = source;
          await image.decode();
          return image;
        }),
      );
      const canvas = document.querySelector("canvas")!;
      const actual = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      // This fixture is a strip of 480px square illustrations. At 240 DIP/2x
      // each cell is one whole window: compare PNG pixels, without consulting
      // atlas foot/scale metadata or any production projection function.
      if (canvas.width !== 480 || canvas.height !== 480)
        throw new Error("Unexpected fixture size");
      const comparison = document.createElement("canvas");
      comparison.width = comparison.height = 480;
      const context = comparison.getContext("2d")!;
      const mismatches: {
        authored: number;
        mirrored: number;
        alpha: number;
      }[] = [];
      for (let frame = 0; frame < images[0]!.width / 480; frame++) {
        context.clearRect(0, 0, 480, 480);
        context.drawImage(images[0]!, frame * 480, 0, 480, 480, 0, 0, 480, 480);
        const authored = context.getImageData(0, 0, 480, 480).data;
        context.clearRect(0, 0, 480, 480);
        context.save();
        context.translate(480, 0);
        context.scale(-1, 1);
        context.drawImage(images[1]!, frame * 480, 0, 480, 480, 0, 0, 480, 480);
        context.restore();
        const mirrored = context.getImageData(0, 0, 480, 480).data;
        let authoredDifference = 0,
          mirroredDifference = 0,
          alphaDifference = 0;
        for (let i = 0; i < actual.length; i++) {
          if (Math.abs(actual[i]! - authored[i]!) > 2) authoredDifference++;
          if (Math.abs(actual[i]! - mirrored[i]!) > 2) mirroredDifference++;
          if (i % 4 === 3 && actual[i] !== mirrored[i]) alphaDifference++;
        }
        mismatches.push({
          authored: authoredDifference,
          mirrored: mirroredDifference,
          alpha: alphaDifference,
        });
      }
      return mismatches.sort((a, b) => a.authored - b.authored)[0]!;
    }, sources),
  );
  expect(compared.authored).toBe(0);
  expect(compared.mirrored).toBeGreaterThan(30);
  expect(compared.alpha).toBe(0);
  const { body } = await paintedPoints(pet, session.run);
  const before = await session.run("app-evaluate", () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Mosey")!
        .getBounds(),
    ),
  );
  await session.run("pet-move", () => pet.mouse.move(body.x, body.y));
  await session.run("pet-down", () => pet.mouse.down());
  await session.run("pet-move", () => pet.mouse.move(body.x, body.y - 60));
  await expect
    .poll(() =>
      session.run("app-evaluate", () =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((window) => window.getTitle() === "Mosey")!
              .getBounds().y,
        ),
      ),
    )
    .toBeLessThan(before.y - 40);
  await session.run("pet-up", () => pet.mouse.up());
});
