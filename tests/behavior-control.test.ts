import { expect, onTestFinished, test } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { matchPaintedFrames } from "./support/pixels";
import { controlBehavior } from "./support/controlled-behavior";
import { openSettings, closeSettings } from "./support/settings";
import { exerciseBehaviorDeadline } from "./support/behavior-deadline";

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
      app.evaluate(exerciseBehaviorDeadline, {
        journal: path.join(session.evidence, "behavior-third-events.jsonl"),
        duringPublication: false,
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
  expect(elapsed.inputFailure).toBeUndefined();
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

test("advancing behavior time preserves a cold character preparation deadline", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    behavior: { random: 0.1, running: false },
    preferences: {
      version: 3,
      character: "corgi",
      size: 160,
      visibility: "visible",
    },
  });
  const { app, renderer } = await session.launch();
  const settings = await openSettings(app, { run: session.run });
  await renderer.withColdImages(
    async (release) => {
      await session.run("select-cold-character", () =>
        settings.getByRole("combobox", { name: "角色" }).selectOption("whale"),
      );
      await expect
        .poll(() =>
          session.run("cold-character-requested", () =>
            app.evaluate(() =>
              Reflect.get(globalThis, "recoveryImageRequested"),
            ),
          ),
        )
        .toBe(true);
      await session.run("delayed-character-control", () =>
        app.evaluate(
          () => new Promise<void>((resolve) => setTimeout(resolve, 2500)),
        ),
      );
      // Ten behavior minutes exceed the 15s preparation budget. Keep the image
      // request held across slow driver work until this assertion has finished.
      await session.run("advance-during-character-preparation", () =>
        controlBehavior(app, { advanceBy: 600000 }),
      );
      const pending = await session.run("cold-character-pending", () =>
        settings.evaluate(() => window.moseySettings.get()),
      );
      expect(pending.character).toBe("corgi");
      expect(pending.pendingCharacter).toEqual({
        target: "whale",
        phase: "loading",
      });
      expect(pending.failedCharacter).toBeUndefined();
      await release();
      await expect
        .poll(
          async () =>
            (
              await session.run(
                "prepared-character-presentation",
                renderer.read,
              )
            )?.presentation.character,
          { timeout: 10000 },
        )
        .toBe("whale");
    },
    session.run,
    { holdUntilReleased: true },
  );
  const frame = await session.run("prepared-character-paint", () =>
    renderer.waitUntilReady({ paintedPixels: 600 }),
  );
  expect(frame.presentation.character).toBe("whale");
  expect(frame.label).toBe("鲸鱼娘 · 待机");
  await closeSettings(app, { run: session.run });
  await session.quit();
  await session.close();
});

test.each(["corgi", "whale"] as const)(
  "production-default %s keeps its real activity cadence without a behavior controller",
  async (character) => {
    const session = await createPetTestSession({
      dock: "empty",
      preferences: {
        version: 3,
        character,
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

    // Observe ordinary presentation and pixels. Do not substitute randomness or
    // advance behavior time: any of the three natural activities is acceptable.
    const observations = [frame.presentation];
    onTestFinished(() =>
      writeFile(
        path.join(session.evidence, "real-behavior.json"),
        JSON.stringify(
          { character, scale: frame.scaleFactor, observations },
          null,
          2,
        ),
      ),
    );
    let rest = frame.presentation;
    const idleFrames = new Set([frame.pixels, frame.mirroredPixels]);
    let activity: typeof frame | null = null;
    await expect
      .poll(
        async () => {
          activity = await session.run(
            "real-activity-presentation",
            renderer.read,
          );
          if (!activity) return undefined;
          const presentation = activity.presentation;
          if (observations.at(-1)?.actionId !== presentation.actionId)
            observations.push(presentation);
          if (presentation.posture === "resting") {
            rest = presentation;
            idleFrames.add(activity.pixels);
            idleFrames.add(activity.mirroredPixels);
          }
          return presentation.posture;
        },
        { timeout: 35000, interval: 100 },
      )
      .toMatch(/^(walking|stretching|playing)$/);
    const active = activity!;
    const restDuration = active.presentation.startedAt - rest.startedAt;
    // The 18–32s product window is unchanged. Allow ordinary event-loop delivery
    // latency, never a shorter rest; deterministic coverage checks exact edges.
    expect(restDuration).toBeGreaterThanOrEqual(17999);
    expect(restDuration).toBeLessThan(33000);
    expect(active.presentation.character).toBe(character);
    expect(active.opaquePixels).toBeGreaterThan(600);
    expect(active.presentation.frozenAt).toBeUndefined();
    const matchesIdle = matchPaintedFrames(idleFrames);
    await expect
      .poll(
        async () => {
          const painted = await session.run(
            "real-activity-paint",
            renderer.read,
          );
          return (
            painted?.presentation.actionId === active.presentation.actionId &&
            painted.opaquePixels > 600 &&
            !matchesIdle(painted.pixels)
          );
        },
        { timeout: 1000, interval: 25 },
      )
      .toBe(true);

    let returned: typeof frame | null = null;
    await expect
      .poll(
        async () => {
          returned = await session.run(
            "real-activity-completion",
            renderer.read,
          );
          return returned?.presentation.posture;
        },
        { timeout: 5000, interval: 50 },
      )
      .toBe("resting");
    observations.push(returned!.presentation);
    const durations: Record<string, number> =
      character === "corgi"
        ? { walking: 2400, stretching: 1900, playing: 1760 }
        : { walking: 2160, stretching: 1280, playing: 1120 };
    const duration = durations[active.presentation.posture]!;
    const elapsed =
      returned!.presentation.startedAt - active.presentation.startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(duration - 1);
    expect(elapsed).toBeLessThan(duration + 1000);
    expect(returned!.opaquePixels).toBeGreaterThan(600);
    await session.quit();
    await session.close();
  },
);
