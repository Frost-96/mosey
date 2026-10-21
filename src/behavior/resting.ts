import { assign, setup } from "xstate";

// Tuning value, not a fixed product requirement. Active reactions absorb all clicks.
export const clickMergeIntervalMs = 350;
// Product tuning, intentionally not user settings. Rest dominates each cycle.
export const autonomy = {
  restMinMs: 18000,
  restVariationMs: 14000,
  walkMs: 2400,
  walkDistance: 150,
};
export const petBehavior = setup({
  types: {
    context: {} as {
      actionId: number;
      startedAt: number;
      lastClickAt: number;
      choice: number;
      direction: "left" | "right";
    },
    events: {} as
      | { type: "CLICK" }
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
    walkDuration: () => autonomy.walkMs,
  },
  guards: {
    freshClick: ({ context }) =>
      Date.now() - context.lastClickAt >= clickMergeIntervalMs,
    currentAction: ({ context, event }) =>
      (event.type === "DONE" || event.type === "LANDED") &&
      event.actionId === context.actionId,
  },
  actions: {
    begin: assign(({ context }) => ({
      actionId: context.actionId + 1,
      startedAt: Date.now(),
      lastClickAt: Date.now(),
    })),
    rest: assign(({ context }) => ({
      lastClickAt: 0,
      actionId: context.actionId + 1,
      startedAt: Date.now(),
    })),
  },
}).createMachine({
  id: "pet",
  context: {
    actionId: 0,
    startedAt: Date.now(),
    lastClickAt: 0,
    choice: 0,
    direction: "right",
  },
  initial: "paused",
  on: {
    FACE: { actions: assign(({ event }) => ({ direction: event.direction })) },
    PAUSE: { target: ".paused", actions: "rest" },
    RESUME: { target: ".resting", actions: "rest" },
    CANCEL: { target: ".resting", actions: "rest" },
    DRAG_START: { target: ".dragging", actions: "rest" },
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
    resting: {
      after: { restDelay: { target: "autonomous" } },
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
