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
  const before = await session.run(
    "initial-behavior-paint",
    () => renderer.waitUntilReady({ paintedPixels: 600 }),
    { timeout: 10000 },
  );
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
        let firstWakeup: { wall: number; monotonic: number } | undefined;
        const timeout = new Promise<void>((resolve) => {
          // A timer callback can arrive before its nominal delay. Keep the
          // deadline at 300 real milliseconds; only rearm its remaining time.
          const check = () => {
            const elapsed = {
              wall: Date.now() - wall,
              monotonic: performance.now() - monotonic,
            };
            firstWakeup ??= elapsed;
            const remaining = 300 - Math.min(elapsed.wall, elapsed.monotonic);
            if (remaining > 0) setTimeout(check, remaining);
            else resolve();
          };
          setTimeout(check, 300);
        });
        await controller.update({ advanceBy: 180000 });
        const immediately = Date.now() - wall;
        await timeout;
        return {
          immediately,
          firstWakeup,
          wall: Date.now() - wall,
          monotonic: performance.now() - monotonic,
        };
      }),
  );
  const after = await session.run(
    "advanced-behavior-presentation",
    renderer.read,
  );
  // Preserve public observations before an assertion can fail. The original CI
  // failure retained neither the input timing nor the pre-advance posture.
  await session.run("record-behavior-input", () =>
    writeFile(
      path.join(session.evidence, "behavior-input.json"),
      JSON.stringify(
        { elapsed, before: before.presentation, after: after?.presentation },
        null,
        2,
      ),
    ),
  );
  expect(elapsed.immediately).toBeLessThan(300);
  expect(elapsed.wall).toBeGreaterThanOrEqual(300);
  expect(elapsed.monotonic).toBeGreaterThanOrEqual(300);
  expect(Math.abs(elapsed.wall - elapsed.monotonic)).toBeLessThan(50);
  await expect
    .poll(
      async () =>
        (await session.run("sleep-presentation", renderer.read))?.presentation
          .posture,
    )
    .toBe("sleeping");
  const frame = await session.run(
    "behavior-paint",
    () => renderer.waitUntilReady({ paintedPixels: 600 }),
    { timeout: 10000 },
  );
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
  await session.quit();
  await session.close();
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
    await session.run("production-controller-absent", () =>
      app.evaluate(() =>
        Reflect.has(globalThis, Symbol.for("mosey.test.behavior")),
      ),
    ),
  ).toBe(false);
  const frame = await session.run(
    "behavior-paint",
    () => renderer.waitUntilReady({ paintedPixels: 600 }),
    { timeout: 10000 },
  );
  expect(frame.presentation.posture).toBe("resting");
  expect(frame.scaleFactor).toBe(
    Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
  );
  await session.quit();
  await session.close();
});
