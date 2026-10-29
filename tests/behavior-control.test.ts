import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";

// Application wiring and real deadlines are observed in the actual Electron
// process. The control object supplies inputs; all pet assertions use IPC/paint.
test("controlled behavior reaches sleep without advancing an unrelated real deadline", async () => {
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
  await renderer.waitUntilReady({ paintedPixels: 600 });
  const elapsed = await session.run(
    "real-deadline-during-behavior-advance",
    () =>
      app.evaluate(async () => {
        const controller = Reflect.get(
          globalThis,
          Symbol.for("mosey.test.behavior"),
        );
        if (!controller)
          throw new Error("Controlled behavior build was not installed");
        const wall = Date.now();
        const monotonic = performance.now();
        const timeout = new Promise<void>((resolve) =>
          setTimeout(resolve, 300),
        );
        controller.update({ advanceBy: 180000 });
        const immediately = Date.now() - wall;
        await timeout;
        return {
          immediately,
          wall: Date.now() - wall,
          monotonic: performance.now() - monotonic,
        };
      }),
  );
  expect(elapsed.immediately).toBeLessThan(300);
  expect(elapsed.wall).toBeGreaterThanOrEqual(300);
  expect(elapsed.monotonic).toBeGreaterThanOrEqual(300);
  expect(Math.abs(elapsed.wall - elapsed.monotonic)).toBeLessThan(50);
  await expect
    .poll(async () => (await renderer.read())?.presentation.posture)
    .toBe("sleeping");
  const frame = await renderer.waitUntilReady({ paintedPixels: 600 });
  expect(frame.presentation.posture).toBe("sleeping");
  expect(frame.scaleFactor).toBe(
    Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
  );
  await session.run("record-behavior-deadline", () =>
    writeFile(
      path.join(session.evidence, "behavior-deadline.json"),
      JSON.stringify(
        {
          elapsed,
          requestedScale: Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
          observedScale: frame.scaleFactor,
          posture: frame.presentation.posture,
        },
        null,
        2,
      ),
    ),
  );
});

test("production-default application paints without a behavior controller", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      size: 160,
      visibility: "visible",
    },
  });
  const { app, renderer } = await session.launch();
  expect(
    await app.evaluate(() =>
      Reflect.has(globalThis, Symbol.for("mosey.test.behavior")),
    ),
  ).toBe(false);
  const frame = await renderer.waitUntilReady({ paintedPixels: 600 });
  expect(frame.presentation.posture).toBe("resting");
  expect(frame.scaleFactor).toBe(
    Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
  );
});
