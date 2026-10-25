import { assign, setup } from "xstate";

// Tuning value, not a fixed product requirement. Active reactions absorb all clicks.
export const clickMergeIntervalMs = 350;
export const petBehavior = setup({
  types: {
    context: {} as {
      actionId: number;
      startedAt: number;
      lastClickAt: number;
      choice: number;
    },
    events: {} as
      | { type: "CLICK" }
      | { type: "DONE"; actionId: number }
      | { type: "CANCEL" },
  },
  guards: {
    freshClick: ({ context }) =>
      Date.now() - context.lastClickAt >= clickMergeIntervalMs,
    currentAction: ({ context, event }) =>
      event.type === "DONE" && event.actionId === context.actionId,
  },
  actions: {
    begin: assign(({ context }) => ({
      actionId: context.actionId + 1,
      startedAt: Date.now(),
      lastClickAt: Date.now(),
    })),
    rest: assign(({ context }) => ({
      actionId: context.actionId + 1,
      startedAt: Date.now(),
    })),
  },
}).createMachine({
  id: "pet",
  context: { actionId: 0, startedAt: Date.now(), lastClickAt: 0, choice: 0 },
  initial: "resting",
  on: { CANCEL: { target: ".resting", actions: "rest" } },
  states: {
    resting: {
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
