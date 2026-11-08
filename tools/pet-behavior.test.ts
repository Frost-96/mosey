import assert from "node:assert/strict";
import { test } from "node:test";
import { createActor, SimulatedClock } from "xstate";
import {
  autonomy,
  petBehavior,
  type LoopTimings,
} from "../src/behavior/pet-machine.ts";
import { Timeline } from "../src/behavior/timeline.ts";
import {
  dailyActionDefinitions,
  type CharacterCapability,
  type DailyAction,
} from "../src/shared/character-capabilities.ts";

const originalCapabilities: CharacterCapability[] = [
  "sleep",
  "stretching",
  "playing",
  "tilt",
  "paw",
  "belly",
  "flutter",
  "climbing",
];
const dailyCapabilities: CharacterCapability[] = [
  ...originalCapabilities,
  "looking",
  "sitting",
  "yawning",
  "petted",
  "grooming",
  "celebrating",
  "habit",
];

function fixture(
  capabilities = dailyCapabilities,
  loopTimings?: LoopTimings,
  paintedHandoffs = false,
) {
  const clock = new SimulatedClock();
  clock.increment(1000);
  const actor = createActor(petBehavior, {
    clock,
    input: {
      now: () => clock.now(),
      capabilities,
      loopTimings,
      paintedHandoffs,
    },
  }).start();
  actor.send({ type: "RESUME" });
  return {
    actor,
    clock,
    state: () => actor.getSnapshot().value,
    id: () => actor.getSnapshot().context.actionId,
    done: () =>
      actor.send({
        type: "DONE",
        actionId: actor.getSnapshot().context.actionId,
      }),
    play: (action: DailyAction) => actor.send({ type: "PLAY", action }),
    painted: (frame: number) =>
      actor.send({
        type: "LOOP_FRAME",
        actionId: actor.getSnapshot().context.actionId,
        frame,
      }),
  };
}

function withRandom<T>(value: number, body: () => T): T {
  const original = Math.random;
  Math.random = () => value;
  try {
    return body();
  } finally {
    Math.random = original;
  }
}

test("daily one-shots require their capability and only their current DONE completes them", () => {
  for (const { action, capability } of dailyActionDefinitions) {
    if (action === "sitting" || action === "standingup") continue;
    const pet = fixture([capability]);
    try {
      const oldId = pet.id();
      pet.play(action);
      assert.equal(pet.state(), action);
      pet.actor.send({ type: "DONE", actionId: oldId });
      assert.equal(pet.state(), action);
      pet.done();
      assert.equal(pet.state(), "resting");
      assert.equal(pet.actor.getSnapshot().context.pendingActivity, undefined);
    } finally {
      pet.actor.stop();
    }
    const unsupported = fixture([]);
    try {
      const id = unsupported.id();
      unsupported.play(action);
      assert.equal(unsupported.state(), "resting");
      assert.equal(unsupported.id(), id);
    } finally {
      unsupported.actor.stop();
    }
  }
});

test("ground one-shots finish before playing the latest supported command", () => {
  const cases = [
    { action: "stretching", autonomyChoice: 0.35 },
    { action: "playing", autonomyChoice: 0.45 },
    { action: "tilt", reactionChoice: 0.125 },
    { action: "paw", reactionChoice: 0.375 },
    { action: "belly", reactionChoice: 0.625 },
    ...(
      [
        "looking",
        "yawning",
        "petted",
        "grooming",
        "celebrating",
        "habit",
      ] as const
    ).map((action) => ({ action, command: action })),
  ];
  for (const entry of cases) {
    const pet = fixture();
    try {
      if ("autonomyChoice" in entry && entry.autonomyChoice !== undefined) {
        withRandom(entry.autonomyChoice, () =>
          pet.clock.increment(autonomy.restMinMs + autonomy.restVariationMs),
        );
      } else if (
        "reactionChoice" in entry &&
        entry.reactionChoice !== undefined
      ) {
        withRandom(entry.reactionChoice, () =>
          pet.actor.send({ type: "CLICK" }),
        );
      } else if ("command" in entry) {
        pet.play(entry.command);
      }
      assert.equal(pet.state(), entry.action);
      const currentId = pet.id();
      pet.play("looking");
      pet.play("grooming");
      pet.play("standingup"); // Invalid outside the seated chain; cannot replace the queue.
      pet.actor.send({ type: "DONE", actionId: currentId - 1 });
      assert.equal(pet.state(), entry.action);
      assert.equal(pet.id(), currentId);
      assert.equal(pet.actor.getSnapshot().context.pendingCommand, "grooming");
      pet.done();
      assert.equal(pet.state(), "grooming");
      assert.notEqual(pet.id(), currentId);
      assert.equal(pet.actor.getSnapshot().context.pendingActivity, undefined);
      pet.actor.send({ type: "DONE", actionId: currentId });
      assert.equal(pet.state(), "grooming");
      pet.done();
      assert.equal(pet.state(), "resting");
    } finally {
      pet.actor.stop();
    }
  }
});

test("new one-shots defer clicks until their authored finish while petting absorbs them", () => {
  for (const action of [
    "looking",
    "yawning",
    "grooming",
    "celebrating",
    "habit",
  ] as const) {
    const pet = fixture();
    try {
      pet.play(action);
      const id = pet.id();
      pet.play("habit");
      pet.actor.send({ type: "CLICK" });
      assert.equal(pet.state(), action);
      assert.equal(pet.id(), id);
      assert.equal(pet.actor.getSnapshot().context.pendingActivity, "reaction");
      withRandom(0.875, () => pet.done());
      assert.equal(pet.state(), "petted");
      const pettedId = pet.id();
      pet.play("grooming");
      pet.actor.send({ type: "CLICK" });
      assert.equal(pet.id(), pettedId);
      assert.equal(pet.actor.getSnapshot().context.pendingCommand, "grooming");
      pet.done();
      assert.equal(pet.state(), "grooming");
    } finally {
      pet.actor.stop();
    }
  }
});

test("walking still stops immediately for a daily command", () => {
  withRandom(0.1, () => {
    const pet = fixture();
    try {
      pet.clock.increment(autonomy.restMinMs + autonomy.restVariationMs);
      assert.equal(pet.state(), "walking");
      const walkingId = pet.id();
      pet.play("looking");
      assert.equal(pet.state(), "looking");
      assert.notEqual(pet.id(), walkingId);
    } finally {
      pet.actor.stop();
    }
  });
});

test("daily characters finish original idle gestures before the latest click reaction", () => {
  for (const choice of [0.35, 0.45]) {
    const pet = fixture();
    try {
      withRandom(choice, () =>
        pet.clock.increment(autonomy.restMinMs + autonomy.restVariationMs),
      );
      assert.ok(pet.state() === "stretching" || pet.state() === "playing");
      const action = pet.state();
      const id = pet.id();
      pet.play("habit");
      pet.actor.send({ type: "CLICK" });
      assert.equal(pet.state(), action);
      assert.equal(pet.id(), id);
      assert.equal(pet.actor.getSnapshot().context.pendingActivity, "reaction");
      withRandom(0.125, () => pet.done());
      assert.equal(pet.state(), "tilt");
      assert.equal(pet.actor.getSnapshot().context.pendingActivity, undefined);
      pet.done();
      assert.equal(pet.state(), "resting");
    } finally {
      pet.actor.stop();
    }
  }
});

test("sitting plays down, holds for seven active seconds, then rises once", () => {
  const pet = fixture();
  try {
    pet.play("sitting");
    const downId = pet.id();
    pet.play("sitting");
    assert.equal(pet.state(), "sittingdown");
    assert.equal(pet.id(), downId);
    pet.done();
    assert.equal(pet.state(), "sitting");
    const seatedId = pet.id();
    pet.clock.increment(autonomy.sittingMs - 1);
    pet.play("sitting");
    pet.done(); // A loop acknowledgement does not shorten the seated hold.
    assert.equal(pet.state(), "sitting");
    assert.equal(pet.id(), seatedId);
    pet.clock.increment(1);
    assert.equal(pet.state(), "standingup");
    pet.actor.send({ type: "DONE", actionId: seatedId });
    assert.equal(pet.state(), "standingup");
    pet.done();
    assert.equal(pet.state(), "resting");
  } finally {
    pet.actor.stop();
  }
});

test("commands during descent wait for a full rise and the latest command wins", () => {
  const pet = fixture();
  try {
    pet.play("sitting");
    const downId = pet.id();
    pet.play("habit");
    assert.equal(pet.state(), "sittingdown");
    assert.equal(pet.id(), downId);
    pet.done();
    assert.equal(pet.state(), "standingup");
    const riseId = pet.id();
    pet.play("grooming");
    assert.equal(pet.id(), riseId);
    pet.done();
    assert.equal(pet.state(), "grooming");
    pet.actor.send({ type: "DONE", actionId: riseId });
    assert.equal(pet.state(), "grooming");
    pet.done();
    pet.clock.increment(autonomy.sittingMs);
    assert.equal(pet.state(), "resting");
  } finally {
    pet.actor.stop();
  }
});

test("clicks from every seated phase rise before petting without restarting the rise", () => {
  for (const phase of ["sittingdown", "sitting", "standingup"] as const) {
    const pet = fixture(["sitting", "petted"]);
    try {
      pet.play("sitting");
      if (phase !== "sittingdown") pet.done();
      if (phase === "standingup") pet.play("standingup");
      pet.actor.send({ type: "CLICK" });
      if (phase === "sittingdown") {
        assert.equal(pet.state(), "sittingdown");
        pet.done();
      }
      assert.equal(pet.state(), "standingup");
      const riseId = pet.id();
      pet.actor.send({ type: "CLICK" });
      assert.equal(pet.id(), riseId);
      pet.done();
      assert.equal(pet.state(), "petted");
      const pettedId = pet.id();
      pet.actor.send({ type: "CLICK" });
      assert.equal(pet.id(), pettedId);
      pet.done();
      assert.equal(pet.state(), "resting");
    } finally {
      pet.actor.stop();
    }
  }
});

test("stand up is inert on standing poses and exits an unfinished sit safely", () => {
  const pet = fixture();
  try {
    const id = pet.id();
    pet.play("standingup");
    assert.equal(pet.state(), "resting");
    assert.equal(pet.id(), id);
    pet.play("sitting");
    pet.play("standingup");
    assert.equal(pet.state(), "sittingdown");
    pet.done();
    assert.equal(pet.state(), "standingup");
    pet.done();
    assert.equal(pet.state(), "resting");
  } finally {
    pet.actor.stop();
  }
});

test("cancel and climbing finish the seated chain before returning or moving", () => {
  for (const phase of ["sittingdown", "sitting", "standingup"] as const) {
    for (const type of ["CANCEL", "CLIMB"] as const) {
      const pet = fixture();
      try {
        pet.play("sitting");
        if (phase !== "sittingdown") pet.done();
        if (phase === "standingup") pet.play("standingup");
        pet.actor.send({ type });
        if (phase === "sittingdown") {
          assert.equal(pet.state(), "sittingdown");
          pet.done();
        }
        assert.equal(pet.state(), "standingup");
        const riseId = pet.id();
        pet.actor.send({ type });
        assert.equal(pet.id(), riseId);
        pet.done();
        assert.equal(pet.state(), type === "CLIMB" ? "climbing" : "resting");
      } finally {
        pet.actor.stop();
      }
    }
  }
});

test("a seated pet rises before sleep, and a sleeping pet wakes before a command", () => {
  const pet = fixture();
  try {
    pet.play("sitting");
    pet.clock.increment(autonomy.awakeMs - 1000);
    pet.done();
    assert.equal(pet.state(), "sitting");
    pet.clock.increment(autonomy.sittingMs);
    assert.equal(pet.state(), "standingup");
    pet.done();
    assert.equal(pet.state(), "settling");
    pet.done();
    assert.equal(pet.state(), "sleeping");
    pet.play("looking");
    assert.equal(pet.state(), "waking");
    const wakingId = pet.id();
    pet.play("habit");
    assert.equal(pet.id(), wakingId);
    pet.done();
    assert.equal(pet.state(), "habit");
  } finally {
    pet.actor.stop();
  }
});

test("pause needs no renderer acknowledgement and resumes through a complete rise", () => {
  for (const phase of ["sittingdown", "sitting", "standingup"] as const) {
    const pet = fixture();
    try {
      pet.play("sitting");
      if (phase !== "sittingdown") pet.done();
      if (phase === "standingup") pet.play("standingup");
      const interruptedId = pet.id();
      pet.actor.send({ type: "PAUSE" });
      assert.equal(pet.state(), "paused");
      pet.actor.send({ type: "PAUSE" });
      pet.actor.send({ type: "DONE", actionId: interruptedId });
      pet.clock.increment(autonomy.sittingMs * 3);
      pet.play("habit");
      assert.equal(pet.state(), "paused");
      pet.actor.send({ type: "CANCEL" }); // Visibility restoration sends this first.
      assert.equal(pet.state(), "paused");
      pet.actor.send({ type: "RESUME" });
      if (phase === "sittingdown") {
        assert.equal(pet.state(), "sittingdown");
        pet.done();
      }
      assert.equal(pet.state(), "standingup");
      pet.done();
      assert.equal(pet.state(), "resting");
      assert.equal(pet.actor.getSnapshot().context.pendingActivity, undefined);
      assert.equal(pet.actor.getSnapshot().context.resumeSeat, undefined);
    } finally {
      pet.actor.stop();
    }
  }
});

test("dragging preempts new gestures and discards deferred commands", () => {
  for (const action of dailyActionDefinitions.map(({ action }) => action)) {
    const pet = fixture();
    try {
      if (action === "standingup") {
        pet.play("sitting");
        pet.done();
      }
      pet.play(action);
      if (action === "sitting") pet.play("habit");
      const interruptedId = pet.id();
      pet.actor.send({ type: "DRAG_START" });
      assert.equal(pet.state(), "dragging");
      pet.play("celebrating");
      pet.actor.send({ type: "DONE", actionId: interruptedId });
      assert.equal(pet.state(), "dragging");
      assert.equal(pet.actor.getSnapshot().context.pendingActivity, undefined);
      pet.actor.send({ type: "RELEASE" });
      assert.equal(pet.state(), "flutter");
      pet.done();
      assert.equal(pet.state(), "falling");
      pet.actor.send({ type: "LANDED", actionId: pet.id() });
      assert.equal(pet.state(), "landing");
      pet.done();
      assert.equal(pet.state(), "resting");
    } finally {
      pet.actor.stop();
    }
  }
});

test("returning pets retain only the last supported command until landing completes", () => {
  const pet = fixture(["stretching", "looking", "flutter", "climbing"]);
  try {
    for (const start of ["DRAG_START", "CLIMB"] as const) {
      pet.actor.send({ type: start });
      if (start === "DRAG_START") {
        pet.actor.send({ type: "RELEASE" });
        pet.play("looking");
        assert.equal(pet.state(), "flutter");
        pet.done();
        assert.equal(pet.state(), "falling");
      }
      const returning = pet.state();
      pet.play("stretching");
      pet.play("looking");
      pet.play("stretching");
      pet.play("habit"); // Unavailable input must not replace the valid request.
      assert.equal(pet.state(), returning);
      pet.actor.send({ type: "LANDED", actionId: pet.id() });
      assert.equal(pet.state(), "landing");
      pet.done();
      assert.equal(pet.state(), "stretching");
      pet.done();
      assert.equal(pet.state(), "resting");
      assert.equal(pet.actor.getSnapshot().context.pendingActivity, undefined);
    }
  } finally {
    pet.actor.stop();
  }
});

test("retiring a selection drops queued commands without interrupting physical support", () => {
  const pet = fixture();
  try {
    pet.actor.send({ type: "DROP" });
    pet.play("stretching");
    pet.actor.send({ type: "CANCEL_PLAY" });
    assert.equal(pet.state(), "falling");
    pet.actor.send({ type: "LANDED", actionId: pet.id() });
    pet.done();
    assert.equal(pet.state(), "resting");
    pet.play("sitting");
    pet.actor.send({ type: "CLIMB" });
    pet.actor.send({ type: "CANCEL_PLAY" });
    pet.done();
    pet.done();
    assert.equal(pet.state(), "climbing");
  } finally {
    pet.actor.stop();
  }
});

test("a pending command survives changed support and a deferred seated climb", () => {
  const pet = fixture();
  try {
    pet.actor.send({ type: "DROP" });
    pet.play("stretching");
    pet.actor.send({ type: "DROP" });
    pet.actor.send({ type: "CLIMB" });
    pet.actor.send({ type: "DROP" });
    pet.actor.send({ type: "LANDED", actionId: pet.id() });
    pet.done();
    assert.equal(pet.state(), "stretching");
    pet.done();
    pet.play("sitting");
    pet.actor.send({ type: "CLIMB" });
    pet.play("looking");
    pet.play("stretching");
    pet.done();
    assert.equal(pet.state(), "standingup");
    pet.done();
    assert.equal(pet.state(), "climbing");
    pet.actor.send({ type: "LANDED", actionId: pet.id() });
    pet.done();
    assert.equal(pet.state(), "stretching");
    pet.done();
    assert.equal(pet.state(), "resting");
  } finally {
    pet.actor.stop();
  }
});

test("retiring a command preserves an already expired seated deadline", () => {
  const pet = fixture(dailyCapabilities, {
    sitting: { durationMs: 2500, neutralMs: 100 },
  });
  try {
    pet.play("sitting");
    pet.done();
    pet.clock.increment(6500);
    pet.play("stretching");
    pet.clock.increment(500);
    pet.actor.send({ type: "CANCEL_PLAY" });
    pet.clock.increment(500);
    assert.equal(pet.state(), "standingup");
    pet.done();
    assert.equal(pet.state(), "resting");
  } finally {
    pet.actor.stop();
  }
});

test("commands wait for resolved support even when a landing animation finishes first", () => {
  const pet = fixture();
  try {
    pet.actor.send({ type: "DROP" });
    pet.play("looking");
    pet.actor.send({ type: "SUPPORT_PENDING", pending: true });
    pet.actor.send({ type: "LANDED", actionId: pet.id() });
    pet.done();
    assert.equal(pet.state(), "resting");
    pet.play("stretching");
    assert.equal(pet.state(), "resting");
    pet.actor.send({ type: "DROP" });
    pet.actor.send({ type: "SUPPORT_PENDING", pending: false });
    assert.equal(pet.state(), "falling");
    pet.actor.send({ type: "LANDED", actionId: pet.id() });
    pet.done();
    assert.equal(pet.state(), "stretching");
  } finally {
    pet.actor.stop();
  }
});

test("character replacement clears seated continuations and ignores stale completion", () => {
  const pet = fixture();
  try {
    pet.play("sitting");
    pet.play("habit");
    const interruptedId = pet.id();
    pet.actor.send({
      type: "CHARACTER",
      capabilities: originalCapabilities,
      walkDurationMs: 1700,
      paused: false,
    });
    assert.equal(pet.state(), "resting");
    assert.equal(pet.actor.getSnapshot().context.pendingActivity, undefined);
    assert.equal(pet.actor.getSnapshot().context.walkDurationMs, 1700);
    pet.actor.send({ type: "DONE", actionId: interruptedId });
    pet.play("sitting");
    assert.equal(pet.state(), "resting");
  } finally {
    pet.actor.stop();
  }
});

test("Corgi capabilities retain the exact original freedom and click distributions", () => {
  const autonomous: Record<string, number> = {};
  for (let index = 0; index < 1000; index++) {
    withRandom((index + 0.5) / 1000, () => {
      const pet = fixture(originalCapabilities);
      try {
        pet.clock.increment(autonomy.restMinMs + autonomy.restVariationMs);
        const action = String(pet.state());
        autonomous[action] = (autonomous[action] ?? 0) + 1;
      } finally {
        pet.actor.stop();
      }
    });
  }
  assert.deepEqual(autonomous, { walking: 450, stretching: 300, playing: 250 });
  const reactions: Record<string, number> = {};
  for (let index = 0; index < 300; index++) {
    withRandom((index + 0.5) / 300, () => {
      const pet = fixture(originalCapabilities);
      try {
        pet.actor.send({ type: "CLICK" });
        const action = String(pet.state());
        reactions[action] = (reactions[action] ?? 0) + 1;
      } finally {
        pet.actor.stop();
      }
    });
  }
  assert.deepEqual(reactions, { tilt: 100, paw: 100, belly: 100 });
});

test("petting joins the click pool without removing existing reactions", () => {
  const selected = new Set<string>();
  for (const choice of [0.125, 0.375, 0.625, 0.875]) {
    withRandom(choice, () => {
      const pet = fixture();
      try {
        pet.actor.send({ type: "CLICK" });
        selected.add(String(pet.state()));
      } finally {
        pet.actor.stop();
      }
    });
  }
  assert.deepEqual(selected, new Set(["tilt", "paw", "belly", "petted"]));
});

test("new freedom chooses only available activities and leaves quiet time dominant", () => {
  const selected = new Set<string>();
  for (let index = 0; index < 100; index++) {
    withRandom((index + 0.5) / 100, () => {
      const pet = fixture(["looking", "sitting"]);
      try {
        pet.clock.increment(autonomy.restMinMs + autonomy.restVariationMs);
        selected.add(String(pet.state()));
      } finally {
        pet.actor.stop();
      }
    });
  }
  assert.deepEqual(selected, new Set(["walking", "looking", "sittingdown"]));
  const pet = fixture(["petted"]);
  try {
    pet.actor.send({ type: "CLICK" });
    assert.equal(pet.state(), "petted");
    pet.done();
    pet.clock.increment(autonomy.restMinMs - 1);
    assert.equal(pet.state(), "resting");
  } finally {
    pet.actor.stop();
  }
});

test("daily stationary activities preserve facing while walking and Corgi keep the same random draws", () => {
  for (const capabilities of [dailyCapabilities, originalCapabilities]) {
    for (const choice of [0.1, 0.35, 0.45, 0.58, 0.73, 0.83, 0.9, 0.965]) {
      const pet = fixture(capabilities);
      const originalRandom = Math.random;
      let draws = 0;
      try {
        Math.random = () => [choice, 0.1][draws++];
        pet.clock.increment(autonomy.restMinMs + autonomy.restVariationMs);
        assert.equal(draws, 2);
        const expected =
          capabilities === originalCapabilities || pet.state() === "walking"
            ? "left"
            : "right";
        assert.equal(pet.actor.getSnapshot().context.direction, expected);
      } finally {
        Math.random = originalRandom;
        pet.actor.stop();
      }
    }
  }
});

test("Corgi keeps immediate clicks on original idle gestures even when timing is supplied", () => {
  for (const choice of [0.6, 0.9]) {
    const pet = fixture(originalCapabilities, {
      resting: { durationMs: 5000, neutralMs: 100 },
    });
    try {
      withRandom(choice, () =>
        pet.clock.increment(autonomy.restMinMs + autonomy.restVariationMs),
      );
      assert.ok(pet.state() === "stretching" || pet.state() === "playing");
      withRandom(0.1, () => pet.actor.send({ type: "CLICK" }));
      assert.equal(pet.state(), "tilt");
      assert.equal(pet.actor.getSnapshot().context.pendingActivity, undefined);
    } finally {
      pet.actor.stop();
    }
  }
});

test("seated requests leave inside the neutral frame or wait for its next occurrence", () => {
  const timing = { durationMs: 2500, neutralMs: 500 };
  for (const elapsed of [0, 499, 500, 2499]) {
    for (const event of [
      { type: "PLAY", action: "looking" },
      { type: "CLICK" },
      { type: "CANCEL" },
      { type: "CLIMB" },
    ] as const) {
      const pet = fixture(dailyCapabilities, { sitting: timing });
      try {
        pet.play("sitting");
        pet.done();
        pet.clock.increment(elapsed);
        const id = pet.id();
        pet.actor.send(event);
        if (elapsed >= timing.neutralMs) {
          assert.equal(pet.state(), "sitting");
          assert.equal(pet.id(), id);
          pet.actor.send({ type: "SEAT_READY", actionId: id - 1 });
          pet.clock.increment(timing.durationMs - elapsed - 1);
          assert.equal(pet.state(), "sitting");
          pet.clock.increment(1);
        }
        assert.equal(pet.state(), "standingup");
        pet.actor.send({ type: "SEAT_READY", actionId: id });
        assert.equal(pet.state(), "standingup");
      } finally {
        pet.actor.stop();
      }
    }
  }
});

test("the seven-second seated deadline preserves a queued command and its action identity", () => {
  const pet = fixture(dailyCapabilities, {
    sitting: { durationMs: 2500, neutralMs: 500 },
  });
  try {
    pet.play("sitting");
    pet.done();
    pet.clock.increment(6500);
    const id = pet.id();
    pet.play("looking");
    pet.clock.increment(500);
    assert.equal(pet.state(), "sitting");
    assert.equal(pet.id(), id);
    assert.equal(pet.actor.getSnapshot().context.pendingCommand, "looking");
    pet.clock.increment(100);
    pet.play("grooming");
    pet.clock.increment(399);
    assert.equal(pet.state(), "sitting");
    pet.clock.increment(1);
    assert.equal(pet.state(), "standingup");
    pet.done();
    assert.equal(pet.state(), "grooming");
  } finally {
    pet.actor.stop();
  }
});

test("automatic seated exit and late timer delivery both respect the neutral frame", () => {
  const pet = fixture(dailyCapabilities, {
    sitting: { durationMs: 2500, neutralMs: 100 },
  });
  try {
    pet.play("sitting");
    pet.done();
    pet.clock.increment(7000);
    assert.equal(pet.state(), "sitting");
    assert.equal(pet.actor.getSnapshot().context.pendingActivity, "resting");
    // The event loop wakes after the next neutral window has already ended.
    pet.clock.increment(700);
    assert.equal(pet.state(), "sitting");
    pet.clock.increment(2299);
    assert.equal(pet.state(), "sitting");
    pet.clock.increment(1);
    assert.equal(pet.state(), "standingup");
  } finally {
    pet.actor.stop();
  }
});

test("idle commands and clicks keep the current frame until neutral and the latest request wins", () => {
  const timing = { durationMs: 2000, neutralMs: 300 };
  for (const clicked of [false, true]) {
    const pet = fixture(dailyCapabilities, { resting: timing });
    try {
      pet.clock.increment(500);
      const id = pet.id();
      pet.play("looking");
      pet.clock.increment(300);
      if (clicked) pet.actor.send({ type: "CLICK" });
      else pet.play("grooming");
      assert.equal(pet.state(), "resting");
      assert.equal(pet.id(), id);
      pet.actor.send({ type: "IDLE_READY", actionId: id - 1 });
      pet.clock.increment(1199);
      assert.equal(pet.state(), "resting");
      withRandom(0.875, () => pet.clock.increment(1));
      assert.equal(pet.state(), clicked ? "petted" : "grooming");
      pet.actor.send({ type: "IDLE_READY", actionId: id });
      assert.equal(pet.state(), clicked ? "petted" : "grooming");
    } finally {
      pet.actor.stop();
    }
  }
  const neutral = fixture(dailyCapabilities, { resting: timing });
  try {
    neutral.clock.increment(299);
    neutral.play("looking");
    assert.equal(neutral.state(), "looking");
  } finally {
    neutral.actor.stop();
  }
});

test("rest deadlines align only daily-capable characters to the neutral frame", () => {
  for (const capabilities of [dailyCapabilities, originalCapabilities]) {
    withRandom(0, () => {
      const pet = fixture(capabilities, {
        resting: { durationMs: 5000, neutralMs: 100 },
      });
      try {
        pet.clock.increment(18000);
        assert.equal(
          pet.state(),
          capabilities === originalCapabilities ? "walking" : "resting",
        );
        if (capabilities === dailyCapabilities) {
          pet.clock.increment(1999);
          assert.equal(pet.state(), "resting");
          pet.clock.increment(1);
          assert.equal(pet.state(), "walking");
        }
      } finally {
        pet.actor.stop();
      }
    });
  }
});

test("dragging and character resets cancel deferred loop exits and reject their stale identities", () => {
  for (const posture of ["resting", "sitting"] as const) {
    const timings = { [posture]: { durationMs: 2000, neutralMs: 200 } };
    const pet = fixture(dailyCapabilities, timings);
    try {
      if (posture === "sitting") {
        pet.play("sitting");
        pet.done();
      }
      pet.clock.increment(500);
      const id = pet.id();
      pet.play("habit");
      pet.actor.send({ type: "DRAG_START" });
      pet.clock.increment(2000);
      assert.equal(pet.state(), "dragging");
      pet.actor.send({
        type: "CHARACTER",
        capabilities: dailyCapabilities,
        walkDurationMs: 2400,
        paused: false,
      });
      assert.deepEqual(pet.actor.getSnapshot().context.loopTimings, {});
      pet.actor.send({
        type: posture === "sitting" ? "SEAT_READY" : "IDLE_READY",
        actionId: id,
      });
      assert.equal(pet.state(), "resting");
      pet.play("looking");
      assert.equal(pet.state(), "looking");
    } finally {
      pet.actor.stop();
    }
  }
});

test("an explicit active-time hold preserves an already queued seated exit", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const timeline = new Timeline();
  const actor = createActor(petBehavior, {
    clock: timeline,
    input: {
      now: timeline.now,
      capabilities: dailyCapabilities,
      loopTimings: { sitting: { durationMs: 2500, neutralMs: 500 } },
    },
  }).start();
  try {
    actor.send({ type: "RESUME" });
    actor.send({ type: "PLAY", action: "sitting" });
    actor.send({
      type: "DONE",
      actionId: actor.getSnapshot().context.actionId,
    });
    t.mock.timers.tick(1000);
    actor.send({ type: "PLAY", action: "looking" });
    const id = actor.getSnapshot().context.actionId;
    timeline.pause();
    t.mock.timers.tick(10000);
    assert.equal(actor.getSnapshot().value, "sitting");
    assert.equal(actor.getSnapshot().context.actionId, id);
    timeline.resume();
    t.mock.timers.tick(1499);
    assert.equal(actor.getSnapshot().value, "sitting");
    t.mock.timers.tick(1);
    assert.equal(actor.getSnapshot().value, "standingup");
    actor.send({
      type: "DONE",
      actionId: actor.getSnapshot().context.actionId,
    });
    assert.equal(actor.getSnapshot().value, "looking");
  } finally {
    actor.stop();
    t.mock.timers.reset();
  }
});

test("an idle boundary timer waits for the actual neutral frame instead of racing rAF", () => {
  const pet = fixture(
    dailyCapabilities,
    { resting: { durationMs: 2000, neutralMs: 300 } },
    true,
  );
  try {
    pet.painted(0);
    pet.clock.increment(500);
    pet.painted(3);
    const id = pet.id();
    pet.play("looking");
    pet.clock.increment(1500);
    assert.equal(pet.state(), "resting");
    assert.equal(pet.id(), id);
    pet.clock.increment(20); // No zero-delay retry loop while rAF is outstanding.
    assert.equal(pet.state(), "resting");
    pet.actor.send({ type: "LOOP_FRAME", actionId: id - 1, frame: 0 });
    pet.painted(-1);
    assert.deepEqual(pet.actor.getSnapshot().context.loopFrame, {
      actionId: id,
      frame: 3,
    });
    pet.painted(0);
    assert.equal(pet.state(), "looking");
    assert.equal(pet.actor.getSnapshot().context.loopFrame, undefined);
  } finally {
    pet.actor.stop();
  }
});

test("a seated boundary waits for the painted neutral frame and rejects a late phase acknowledgement", () => {
  const pet = fixture(
    dailyCapabilities,
    { sitting: { durationMs: 2500, neutralMs: 500 } },
    true,
  );
  try {
    pet.painted(0);
    pet.play("sitting");
    pet.done();
    pet.painted(0);
    pet.clock.increment(600);
    pet.painted(2);
    pet.play("looking");
    const id = pet.id();
    pet.painted(0); // Paint report arrives outside the neutral time window.
    assert.equal(pet.state(), "sitting");
    pet.clock.increment(100);
    pet.painted(3);
    pet.clock.increment(1800);
    assert.equal(pet.state(), "sitting");
    assert.equal(pet.id(), id);
    pet.actor.send({ type: "SEAT_READY", actionId: id - 1 });
    assert.equal(pet.state(), "sitting");
    pet.painted(0);
    assert.equal(pet.state(), "standingup");
    assert.equal(pet.actor.getSnapshot().context.loopFrame, undefined);
    pet.done();
    assert.equal(pet.state(), "looking");
  } finally {
    pet.actor.stop();
  }
});

test("a first neutral frame must be painted for the current action and only the latest request runs", () => {
  const pet = fixture(
    dailyCapabilities,
    { resting: { durationMs: 2000, neutralMs: 300 } },
    true,
  );
  try {
    const id = pet.id();
    pet.play("looking");
    pet.play("habit");
    assert.equal(pet.state(), "resting");
    pet.actor.send({ type: "LOOP_FRAME", actionId: id - 1, frame: 0 });
    assert.equal(pet.state(), "resting");
    pet.painted(0);
    assert.equal(pet.state(), "habit");
    pet.done();
    assert.equal(pet.state(), "resting");
    assert.equal(pet.actor.getSnapshot().context.loopFrame, undefined);
    pet.play("grooming");
    pet.actor.send({ type: "LOOP_FRAME", actionId: id, frame: 0 });
    assert.equal(pet.state(), "resting");
    pet.painted(0);
    assert.equal(pet.state(), "grooming");
  } finally {
    pet.actor.stop();
  }
});

test("autonomous activity and sleep wait for idle paint confirmation without losing a newer command", () => {
  for (const intent of ["autonomous", "sleep", "override"] as const) {
    withRandom(0, () => {
      const pet = fixture(
        dailyCapabilities,
        { resting: { durationMs: 5000, neutralMs: 200 } },
        true,
      );
      try {
        pet.painted(0);
        pet.clock.increment(1000);
        pet.painted(3);
        pet.clock.increment(intent === "sleep" ? 119000 : 19000);
        assert.equal(pet.state(), "resting");
        assert.equal(
          pet.actor.getSnapshot().context.pendingActivity,
          intent === "sleep" ? "sleep" : "autonomous",
        );
        if (intent === "override") pet.play("looking");
        pet.painted(0);
        assert.equal(
          pet.state(),
          intent === "sleep"
            ? "settling"
            : intent === "override"
              ? "looking"
              : "walking",
        );
      } finally {
        pet.actor.stop();
      }
    });
  }
});

test("paint acknowledgement state is discarded on drag and character replacement", () => {
  const pet = fixture(
    dailyCapabilities,
    { resting: { durationMs: 2000, neutralMs: 300 } },
    true,
  );
  try {
    pet.clock.increment(500);
    pet.painted(3);
    pet.play("habit");
    const id = pet.id();
    pet.actor.send({ type: "DRAG_START" });
    assert.equal(pet.actor.getSnapshot().context.loopFrame, undefined);
    pet.actor.send({ type: "LOOP_FRAME", actionId: id, frame: 0 });
    pet.clock.increment(1500);
    assert.equal(pet.state(), "dragging");
    pet.actor.send({
      type: "CHARACTER",
      capabilities: dailyCapabilities,
      walkDurationMs: 2400,
      paused: false,
    });
    assert.equal(pet.actor.getSnapshot().context.paintedHandoffs, false);
    assert.equal(pet.actor.getSnapshot().context.loopFrame, undefined);
    pet.actor.send({ type: "LOOP_FRAME", actionId: id, frame: 0 });
    assert.equal(pet.actor.getSnapshot().context.loopFrame, undefined);
    pet.play("looking");
    assert.equal(pet.state(), "looking");
  } finally {
    pet.actor.stop();
  }
});
