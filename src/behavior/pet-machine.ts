import { assign, setup } from "xstate";

// Tuning value, not a fixed product requirement. Active reactions absorb all clicks.
export const clickMergeIntervalMs = 350;
export const wakeClickWindowMs = 900;
// Product tuning, intentionally not user settings. Rest dominates each cycle.
export const autonomy = {
  restMinMs: 18000,
  restVariationMs: 14000,
  walkMs: 2400,
  walkDistance: 150,
  awakeMs: 120000,
};
export const petBehavior = setup({
  types: {
    input: {} as {
      now: () => number;
      walkDurationMs?: number;
    },
    context: {} as {
      now: () => number;
      walkDurationMs: number;
      actionId: number;
      startedAt: number;
      lastClickAt: number;
      awakeSince: number;
      sleepClickAt: number | undefined;
      choice: number;
      direction: "left" | "right";
    },
    events: {} as
      | { type: "CHARACTER"; walkDurationMs: number; paused: boolean }
      | { type: "CLICK" }
      | { type: "CLIMB" }
      | { type: "DROP" }
      | { type: "PAUSE" }
      | { type: "FACE"; direction: "left" | "right" }
      | { type: "RESUME" }
      | { type: "DONE"; actionId: number }
      | { type: "CANCEL" }
      | { type: "DRAG_START" }
      | { type: "RELEASE" }
      | { type: "LANDED"; actionId: number },
  },
  delays: {
    restDelay: () =>
      autonomy.restMinMs + Math.random() * autonomy.restVariationMs,
    walkDuration: ({ context }) => context.walkDurationMs,
  },
  guards: {
    wakeClick: ({ context }) =>
      context.sleepClickAt !== undefined &&
      context.now() - context.sleepClickAt <= wakeClickWindowMs,
    readyToSleep: ({ context }) =>
      context.now() - context.awakeSince >= autonomy.awakeMs,
    freshClick: ({ context }) =>
      context.now() - context.lastClickAt >= clickMergeIntervalMs,
    currentAction: ({ context, event }) =>
      (event.type === "DONE" || event.type === "LANDED") &&
      event.actionId === context.actionId,
  },
  actions: {
    wakeCycle: assign(({ context }) => ({
      awakeSince: context.now(),
      sleepClickAt: undefined,
    })),
    armWake: assign(({ context }) => ({ sleepClickAt: context.now() })),
    begin: assign(({ context }) => ({
      actionId: context.actionId + 1,
      startedAt: context.now(),
      lastClickAt: context.now(),
    })),
    rest: assign(({ context }) => ({
      lastClickAt: 0,
      actionId: context.actionId + 1,
      startedAt: context.now(),
    })),
  },
}).createMachine({
  id: "pet",
  context: ({ input }) => ({
    now: input.now,
    walkDurationMs: input.walkDurationMs ?? autonomy.walkMs,
    actionId: 0,
    startedAt: input.now(),
    lastClickAt: 0,
    awakeSince: input.now(),
    sleepClickAt: undefined,
    choice: 0,
    direction: "right",
  }),
  initial: "paused",
  on: {
    CHARACTER: [
      {
        guard: ({ event }) => event.paused,
        target: ".paused",
        actions: [
          "rest",
          "wakeCycle",
          assign(({ event }) => ({ walkDurationMs: event.walkDurationMs })),
        ],
      },
      {
        target: ".resting",
        actions: [
          "rest",
          "wakeCycle",
          assign(({ event }) => ({ walkDurationMs: event.walkDurationMs })),
        ],
      },
    ],
    FACE: { actions: assign(({ event }) => ({ direction: event.direction })) },
    PAUSE: { target: ".paused", actions: "rest" },
    RESUME: { target: ".resting", actions: ["rest", "wakeCycle"] },
    CANCEL: { target: ".resting", actions: ["rest", "wakeCycle"] },
    DRAG_START: { target: ".dragging", actions: ["rest", "wakeCycle"] },
    CLIMB: { target: ".climbing", actions: ["rest", "wakeCycle"] },
    DROP: { target: ".falling", actions: "rest" },
  },
  states: {
    paused: {},
    autonomous: {
      entry: assign(() => ({
        choice: Math.random(),
        direction: Math.random() < 0.5 ? ("left" as const) : ("right" as const),
      })),
      always: [
        {
          guard: ({ context }) => context.choice < 0.45,
          target: "walking",
          actions: "rest",
        },
        {
          guard: ({ context }) => context.choice < 0.75,
          target: "stretching",
          actions: "rest",
        },
        { target: "playing", actions: "rest" },
      ],
    },
    walking: {
      after: { walkDuration: { target: "resting", actions: "rest" } },
      on: { CLICK: { target: "choosing", actions: "begin" } },
    },
    stretching: {
      on: {
        CLICK: { target: "choosing", actions: "begin" },
        DONE: { guard: "currentAction", target: "resting", actions: "rest" },
      },
    },
    playing: {
      on: {
        CLICK: { target: "choosing", actions: "begin" },
        DONE: { guard: "currentAction", target: "resting", actions: "rest" },
      },
    },
    climbing: {
      on: {
        LANDED: { guard: "currentAction", target: "landing", actions: "rest" },
        CLICK: { target: "choosing", actions: "begin" },
      },
    },
    dragging: { on: { RELEASE: { target: "flutter", actions: "rest" } } },
    flutter: {
      on: {
        DONE: { guard: "currentAction", target: "falling", actions: "rest" },
      },
    },
    falling: {
      on: {
        LANDED: { guard: "currentAction", target: "landing", actions: "rest" },
      },
    },
    landing: {
      on: {
        DONE: { guard: "currentAction", target: "resting", actions: "rest" },
      },
    },
    settling: {
      on: {
        DONE: { guard: "currentAction", target: "sleeping", actions: "rest" },
        CLICK: { target: "waking", actions: ["rest", "wakeCycle"] },
      },
    },
    sleeping: {
      on: {
        CLICK: [
          {
            guard: "wakeClick",
            target: "waking",
            actions: ["rest", "wakeCycle"],
          },
          { target: "ear", actions: ["rest", "armWake"] },
        ],
      },
    },
    ear: {
      on: {
        CLICK: [
          {
            guard: "wakeClick",
            target: "waking",
            actions: ["rest", "wakeCycle"],
          },
          { target: "ear", reenter: true, actions: ["rest", "armWake"] },
        ],
        DONE: { guard: "currentAction", target: "sleeping", actions: "rest" },
      },
    },
    waking: {
      on: {
        DONE: {
          guard: "currentAction",
          target: "resting",
          actions: ["rest", "wakeCycle"],
        },
      },
    },
    resting: {
      after: {
        restDelay: [
          { guard: "readyToSleep", target: "settling", actions: "rest" },
          { target: "autonomous" },
        ],
      },
      on: {
        CLICK: { guard: "freshClick", target: "choosing", actions: "begin" },
      },
    },
    choosing: {
      entry: assign(() => ({ choice: Math.random() })),
      always: [
        { guard: ({ context }) => context.choice < 1 / 3, target: "tilt" },
        { guard: ({ context }) => context.choice < 2 / 3, target: "paw" },
        { target: "belly" },
      ],
    },
    tilt: {
      on: {
        DONE: { guard: "currentAction", target: "resting", actions: "rest" },
      },
    },
    paw: {
      on: {
        DONE: { guard: "currentAction", target: "resting", actions: "rest" },
      },
    },
    belly: {
      on: {
        DONE: { guard: "currentAction", target: "resting", actions: "rest" },
      },
    },
  },
});
