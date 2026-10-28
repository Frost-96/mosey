import { createActor } from "xstate";
import { expect, onTestFinished, test } from "vitest";
import { ControlledBehaviorAdapter } from "../src/behavior/adapters";
import { petBehavior } from "../src/behavior/pet-machine";
import { Timeline } from "../src/behavior/timeline";

function controlledPet(random: () => number = () => 0) {
  const adapter = new ControlledBehaviorAdapter({ random });
  const timeline = new Timeline(adapter);
  const behavior = createActor(petBehavior, {
    clock: timeline,
    input: { now: timeline.now, random: timeline.random },
  }).start();
  onTestFinished(() => {
    behavior.stop();
  });
  behavior.send({ type: "RESUME" });
  return { adapter, behavior, timeline };
}

test("free activity rests before walking and returns to rest after its normal duration", () => {
  const { adapter, behavior } = controlledPet();

  adapter.advanceBy(17999);
  expect(behavior.getSnapshot().value).toBe("resting");
  adapter.advanceBy(1);
  expect(behavior.getSnapshot().value).toBe("walking");
  expect(behavior.getSnapshot().context.direction).toBe("left");
  adapter.advanceBy(2399);
  expect(behavior.getSnapshot().value).toBe("walking");
  adapter.advanceBy(1);
  expect(behavior.getSnapshot().value).toBe("resting");
});

test("the same controlled choices select repeatable click reactions", () => {
  let choice = 0;
  const { adapter, behavior } = controlledPet(() => choice);

  for (const [nextChoice, reaction] of [
    [0, "tilt"],
    [0.5, "paw"],
    [0.99, "belly"],
  ] as const) {
    choice = nextChoice;
    adapter.advanceBy(350);
    behavior.send({ type: "CLICK" });
    expect(behavior.getSnapshot().value).toBe(reaction);
    behavior.send({
      type: "DONE",
      actionId: behavior.getSnapshot().context.actionId,
    });
    expect(behavior.getSnapshot().value).toBe("resting");
  }
});

test("a fresh pet accepts its first click at the controlled clock origin", () => {
  const { behavior } = controlledPet();
  behavior.send({ type: "CLICK" });
  expect(behavior.getSnapshot().value).toBe("tilt");
});

test("a full awake cycle enters sleep and only two clicks within the wake window wake it", () => {
  const { adapter, behavior } = controlledPet();

  adapter.advanceBy(119999);
  expect(behavior.getSnapshot().value).toBe("resting");
  adapter.advanceBy(1);
  expect(behavior.getSnapshot().value).toBe("settling");
  behavior.send({
    type: "DONE",
    actionId: behavior.getSnapshot().context.actionId,
  });
  expect(behavior.getSnapshot().value).toBe("sleeping");

  behavior.send({ type: "CLICK" });
  expect(behavior.getSnapshot().value).toBe("ear");
  behavior.send({
    type: "DONE",
    actionId: behavior.getSnapshot().context.actionId,
  });
  adapter.advanceBy(901);
  behavior.send({ type: "CLICK" });
  expect(behavior.getSnapshot().value).toBe("ear");
  adapter.advanceBy(900);
  behavior.send({ type: "CLICK" });
  expect(behavior.getSnapshot().value).toBe("waking");
  behavior.send({
    type: "DONE",
    actionId: behavior.getSnapshot().context.actionId,
  });
  expect(behavior.getSnapshot().value).toBe("resting");
});

test("menu pause preserves activity and presentation elapsed time across a long clock advance", () => {
  const { adapter, behavior, timeline } = controlledPet();
  adapter.advanceBy(18000);
  expect(behavior.getSnapshot().value).toBe("walking");
  const before = Date.now();
  const moving = timeline.presentation(
    behavior.getSnapshot().context.startedAt,
  );
  expect(moving.startedAt).toBeGreaterThanOrEqual(before);
  expect(moving.startedAt).toBeLessThanOrEqual(Date.now());
  expect(moving.frozenAt).toBeUndefined();

  adapter.advanceBy(700);
  timeline.pause();
  adapter.advanceBy(600000);
  expect(behavior.getSnapshot().value).toBe("walking");
  const frozen = timeline.presentation(
    behavior.getSnapshot().context.startedAt,
  );
  expect(frozen.frozenAt! - frozen.startedAt).toBe(700);
  timeline.resume();
  adapter.advanceBy(1699);
  expect(behavior.getSnapshot().value).toBe("walking");
  adapter.advanceBy(1);
  expect(behavior.getSnapshot().value).toBe("resting");
});

test.each([
  { choice: 0.6, rest: 26400, activity: "stretching" },
  { choice: 0.9, rest: 30600, activity: "playing" },
])(
  "free activity can choose $activity after its varied rest",
  ({ choice, rest, activity }) => {
    const { adapter, behavior } = controlledPet(() => choice);
    adapter.advanceBy(rest - 1);
    expect(behavior.getSnapshot().value).toBe("resting");
    adapter.advanceBy(1);
    expect(behavior.getSnapshot().value).toBe(activity);
    expect(behavior.getSnapshot().context.direction).toBe("right");
    behavior.send({
      type: "DONE",
      actionId: behavior.getSnapshot().context.actionId,
    });
    expect(behavior.getSnapshot().value).toBe("resting");
  },
);

test("dragging cancels pending activity and ignores completion from the interrupted action", () => {
  const { adapter, behavior } = controlledPet();
  adapter.advanceBy(18000);
  const interruptedAction = behavior.getSnapshot().context.actionId;
  behavior.send({ type: "DRAG_START" });
  behavior.send({ type: "CLICK" });
  adapter.advanceBy(600000);
  expect(behavior.getSnapshot().value).toBe("dragging");
  behavior.send({ type: "RELEASE" });
  expect(behavior.getSnapshot().value).toBe("flutter");
  behavior.send({ type: "DONE", actionId: interruptedAction });
  expect(behavior.getSnapshot().value).toBe("flutter");
  behavior.send({
    type: "DONE",
    actionId: behavior.getSnapshot().context.actionId,
  });
  expect(behavior.getSnapshot().value).toBe("falling");
});

test("lifecycle pause and stop prevent later activity, while resume starts a fresh awake cycle", () => {
  const { adapter, behavior } = controlledPet();
  adapter.advanceBy(10000);
  behavior.send({ type: "PAUSE" });
  adapter.advanceBy(600000);
  expect(behavior.getSnapshot().value).toBe("paused");
  behavior.send({ type: "RESUME" });
  adapter.advanceBy(18000);
  expect(behavior.getSnapshot().value).toBe("walking");
  behavior.send({ type: "CANCEL" });
  adapter.advanceBy(17999);
  expect(behavior.getSnapshot().value).toBe("resting");
  adapter.advanceBy(1);
  expect(behavior.getSnapshot().value).toBe("walking");
  behavior.stop();
  adapter.advanceBy(600000);
  expect(behavior.getSnapshot().status).toBe("stopped");
  expect(behavior.getSnapshot().value).toBe("walking");
});

test("advancing behavior time leaves wall deadlines and another pet's behavior untouched", () => {
  let wallDeadlineExpired = false;
  const wallDeadline = Date.now() + 15000;
  const wallTimer = setTimeout(() => {
    wallDeadlineExpired = true;
  }, 15000);
  onTestFinished(() => clearTimeout(wallTimer));

  const adapter = new ControlledBehaviorAdapter({ random: () => 0 });
  const timeline = new Timeline(adapter);
  const behavior = createActor(petBehavior, {
    clock: timeline,
    input: { now: timeline.now, random: timeline.random },
  }).start();
  const otherTimeline = new Timeline();
  const otherPet = createActor(petBehavior, {
    clock: otherTimeline,
    // Existing callers do not have to supply a random adapter.
    input: { now: otherTimeline.now },
  }).start();
  onTestFinished(() => {
    behavior.stop();
    otherPet.stop();
  });
  behavior.send({ type: "RESUME" });
  otherPet.send({ type: "RESUME" });
  adapter.advanceBy(600000);
  expect(behavior.getSnapshot().value).toBe("settling");
  expect(otherPet.getSnapshot().value).toBe("resting");
  expect(wallDeadlineExpired).toBe(false);
  expect(Date.now()).toBeLessThan(wallDeadline);
  const startedAt = otherPet.getSnapshot().context.startedAt;
  expect(otherTimeline.presentation(startedAt)).toEqual({
    startedAt,
    frozenAt: undefined,
  });
});
