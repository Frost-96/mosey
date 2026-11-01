import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { exerciseBehaviorDeadline } from "./support/behavior-deadline";

// The inspector may deliver an input before an existing behavior callback
// returns. Reproduce that interleaving at Electron's real IPC publication:
// forward the genuine walking presentation, then submit the next input.
// No actor, timer queue or behavior snapshot is read or substituted.
for (const { title, interruption } of [
  {
    title:
      "behavior input during an activity publication reaches sleep without advancing a real deadline",
    interruption: "none",
  },
  {
    title:
      "a work-area cancellation starts a new idle cycle without advancing the original real deadline",
    interruption: "work-area",
  },
  {
    title:
      "an unrelated display cancellation does not authorize another behavior input",
    interruption: "unmatched",
  },
  {
    title: "a second work-area cancellation refuses another idle-cycle input",
    interruption: "second",
  },
  {
    title:
      "a hidden pet rejects a queued idle-cycle input after work-area cancellation",
    interruption: "hidden",
  },
] as const) {
  test(title, async () => {
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
    const elapsed = await session.run("overlapping-behavior-input", () =>
      app.evaluate(exerciseBehaviorDeadline, {
        journal: path.join(session.evidence, "behavior-events.jsonl"),
        duringPublication: true,
        interruption,
      }),
    );
    await session.run("record-overlapping-input", () =>
      writeFile(
        path.join(session.evidence, "behavior-input.json"),
        JSON.stringify(elapsed, null, 2),
      ),
    );
    expect(elapsed.firstSettling?.posture).toBe("settling");
    if (interruption !== "none" && interruption !== "unmatched") {
      expect(elapsed.displayCancellation?.before.posture).toBe("settling");
      expect(elapsed.displayCancellation?.after.posture).toBe("resting");
      expect(elapsed.displayCancellation?.after.actionId).toBeGreaterThan(
        elapsed.displayCancellation!.before.actionId,
      );
    }
    if (interruption === "unmatched")
      expect(elapsed.displayCancellation).toBeUndefined();
    expect(elapsed.inputFailure).toBe(
      interruption === "second"
        ? "A second work-area cancellation exceeded this input transaction"
        : interruption === "hidden"
          ? "Controlled behavior input is no longer current"
          : undefined,
    );
    expect(elapsed.immediately).toBeLessThan(300);
    expect(elapsed.wall).toBeGreaterThanOrEqual(300);
    expect(elapsed.monotonic).toBeGreaterThanOrEqual(300);
    expect(Math.abs(elapsed.wall - elapsed.monotonic)).toBeLessThan(50);
    if (interruption === "none" || interruption === "work-area") {
      await expect
        .poll(
          async () =>
            (await session.run("sleep-presentation", renderer.read))
              ?.presentation.posture,
        )
        .toBe("sleeping");
      const frame = await session.run("sleep-paint", () =>
        renderer.waitUntilReady({ paintedPixels: 600 }),
      );
      expect(frame.presentation.posture).toBe("sleeping");
      expect(frame.scaleFactor).toBe(
        Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
      );
    } else {
      const frame = await session.run(
        "cancelled-input-presentation",
        renderer.read,
      );
      expect(frame?.presentation.posture).toBe("resting");
      expect(frame?.presentation.visibility).toBe(
        interruption === "hidden" ? "hidden" : "visible",
      );
      expect(frame?.scaleFactor).toBe(
        Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
      );
    }
    await session.quit();
    await session.close();
  });
}
