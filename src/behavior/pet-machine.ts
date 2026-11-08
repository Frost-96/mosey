import {
  dailyActionDefinitions,
  hasExpandedActivities,
  type CharacterCapability,
  type DailyAction,
} from "../shared/character-capabilities.ts";
import { assign, cancel, enqueueActions, setup } from "xstate";

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
  sittingMs: 7000,
};
type PendingActivity =
  "resting" | "autonomous" | "reaction" | "sleep" | "climbing";
type PendingCommand = Exclude<DailyAction, "standingup"> | "resting";
type Continuation = {
  pendingActivity: PendingActivity | undefined;
  pendingCommand: PendingCommand | undefined;
};
function continuation(context: Continuation) {
  return context.pendingActivity === "climbing"
    ? "climbing"
    : (context.pendingCommand ?? context.pendingActivity);
}
function hasPending(context: Continuation) {
  return continuation(context) !== undefined;
}
type ChoiceContext = {
  choice: number;
  capabilities: CharacterCapability[];
};
export type LoopTimings = Partial<
  Record<"resting" | "sitting", { durationMs: number; neutralMs: number }>
>;
type LoopFrame = { actionId: number; frame: number };
function hasPaintedNeutral(context: {
  paintedHandoffs: boolean;
  actionId: number;
  loopFrame: LoopFrame | undefined;
}) {
  return (
    !context.paintedHandoffs ||
    (context.loopFrame?.actionId === context.actionId &&
      context.loopFrame.frame === 0)
  );
}
function neutralDelay(timing: LoopTimings["resting"], elapsed: number) {
  if (!timing || timing.durationMs <= 0 || timing.neutralMs <= 0) return 0;
  const phase = Math.max(0, elapsed) % timing.durationMs;
  return phase < timing.neutralMs ? 0 : timing.durationMs - phase;
}
// Keep the original chooser untouched for packs without these daily activities.
// Affection and celebration are responses to the user, not random idle gestures.
function dailyActivity(context: ChoiceContext) {
  const extras = [
    ["looking", 16],
    ["sitting", 14],
    ["yawning", 6],
    ["grooming", 7],
    ["habit", 7],
  ] as const;
  const available = extras.filter(([capability]) =>
    context.capabilities.includes(capability),
  );
  if (!available.length) return undefined;
  const choices: [string, number][] = [["walking", 30]];
  if (context.capabilities.includes("stretching"))
    choices.push(["stretching", 12]);
  if (context.capabilities.includes("playing")) choices.push(["playing", 8]);
  choices.push(
    ...available.map(([action, weight]): [string, number] => [action, weight]),
  );
  let remaining =
    context.choice * choices.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [action, weight] of choices) {
    remaining -= weight;
    if (remaining < 0) return action;
  }
  return choices.at(-1)?.[0];
}
function reaction(context: {
  choice: number;
  capabilities: CharacterCapability[];
}) {
  const available = (["tilt", "paw", "belly", "petted"] as const).filter(
    (action) => context.capabilities.includes(action),
  );
  return available[Math.floor(context.choice * available.length)];
}
export const petBehavior = setup({
  types: {
    input: {} as {
      now: () => number;
      walkDurationMs?: number;
      capabilities: CharacterCapability[];
      loopTimings?: LoopTimings;
      paintedHandoffs?: boolean;
    },
    context: {} as {
      now: () => number;
      walkDurationMs: number;
      capabilities: CharacterCapability[];
      loopTimings: LoopTimings;
      paintedHandoffs: boolean;
      loopFrame: LoopFrame | undefined;
      actionId: number;
      startedAt: number;
      lastClickAt: number;
      awakeSince: number;
      sleepClickAt: number | undefined;
      choice: number;
      direction: "left" | "right";
      pendingActivity: PendingActivity | undefined;
      pendingCommand: PendingCommand | undefined;
      supportPending: boolean;
      resumeSeat: "sittingdown" | "standingup" | undefined;
    },
    events: {} as
      | {
          type: "CHARACTER";
          walkDurationMs: number;
          capabilities: CharacterCapability[];
          loopTimings?: LoopTimings;
          paintedHandoffs?: boolean;
          paused: boolean;
        }
      | { type: "CLICK" }
      | { type: "PLAY"; action: DailyAction }
      | { type: "CANCEL_PLAY" }
      | { type: "SUPPORT_PENDING"; pending: boolean }
      | { type: "CLIMB" }
      | { type: "DROP" }
      | { type: "PAUSE" }
      | { type: "FACE"; direction: "left" | "right" }
      | { type: "RESUME" }
      | { type: "DONE"; actionId: number }
      | { type: "SEAT_READY"; actionId: number }
      | { type: "IDLE_READY"; actionId: number }
      | { type: "LOOP_FRAME"; actionId: number; frame: number }
      | { type: "CANCEL" }
      | { type: "DRAG_START" }
      | { type: "RELEASE" }
      | { type: "LANDED"; actionId: number },
  },
  delays: {
    restDelay: ({ context }) => {
      const delay =
        autonomy.restMinMs + Math.random() * autonomy.restVariationMs;
      return hasExpandedActivities(context.capabilities)
        ? delay +
            neutralDelay(
              context.loopTimings.resting,
              context.now() - context.startedAt + delay,
            )
        : delay;
    },
    walkDuration: ({ context }) => context.walkDurationMs,
    sittingDuration: autonomy.sittingMs,
  },
  guards: {
    wakeClick: ({ context }) =>
      context.sleepClickAt !== undefined &&
      context.now() - context.sleepClickAt <= wakeClickWindowMs,
    readyToSleep: ({ context }) =>
      context.capabilities.includes("sleep") &&
      context.now() - context.awakeSince >= autonomy.awakeMs,
    freshClick: ({ context }) =>
      context.now() - context.lastClickAt >= clickMergeIntervalMs,
    currentAction: ({ context, event }) =>
      (event.type === "DONE" || event.type === "LANDED") &&
      event.actionId === context.actionId,
    dailyContinuity: ({ context }) =>
      hasExpandedActivities(context.capabilities),
    currentLoopRequest: ({ context, event }) =>
      (event.type === "SEAT_READY" || event.type === "IDLE_READY") &&
      event.actionId === context.actionId &&
      hasPending(context),
    currentLoopFrame: ({ context, event }) =>
      event.type === "LOOP_FRAME" &&
      event.actionId === context.actionId &&
      Number.isInteger(event.frame) &&
      event.frame >= 0,
    canPlay: ({ context, event }) =>
      event.type === "PLAY" &&
      dailyActionDefinitions.some(
        ({ action, capability }) =>
          action === event.action && context.capabilities.includes(capability),
      ),
    canPlayStandingAction: ({ context, event }) =>
      event.type === "PLAY" &&
      event.action !== "standingup" &&
      dailyActionDefinitions.some(
        ({ action, capability }) =>
          action === event.action && context.capabilities.includes(capability),
      ),
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
      loopFrame: undefined,
    })),
    rest: assign(({ context }) => ({
      lastClickAt: 0,
      actionId: context.actionId + 1,
      startedAt: context.now(),
      loopFrame: undefined,
    })),
    queuePlay: assign(({ event }) =>
      event.type === "PLAY"
        ? {
            pendingCommand:
              event.action === "standingup"
                ? ("resting" as const)
                : event.action,
          }
        : {},
    ),
    queueReaction: assign({
      pendingActivity: "reaction" as const,
      pendingCommand: undefined,
    }),
    queueRest: assign({
      pendingActivity: "resting" as const,
      pendingCommand: undefined,
    }),
    queueAutomaticRest: assign({ pendingActivity: "resting" as const }),
    queueClimb: assign({ pendingActivity: "climbing" as const }),
    queueSleep: assign({ pendingActivity: "sleep" as const }),
    queueIdleActivity: assign(({ context }) => ({
      pendingActivity:
        context.capabilities.includes("sleep") &&
        context.now() - context.awakeSince >= autonomy.awakeMs
          ? ("sleep" as const)
          : ("autonomous" as const),
    })),
    recordLoopFrame: assign(({ event }) =>
      event.type === "LOOP_FRAME"
        ? { loopFrame: { actionId: event.actionId, frame: event.frame } }
        : {},
    ),
    clearPending: assign({
      pendingActivity: undefined,
      pendingCommand: undefined,
    }),
    clearActivity: assign({ pendingActivity: undefined }),
    clearCommand: assign({ pendingCommand: undefined }),
    setSupportPending: assign(({ event }) =>
      event.type === "SUPPORT_PENDING" ? { supportPending: event.pending } : {},
    ),
    clearSeatResume: assign({ resumeSeat: undefined }),
    pauseSittingDown: assign({ resumeSeat: "sittingdown" as const }),
    pauseSeated: assign({ resumeSeat: "standingup" as const }),
    requestSeatExit: enqueueActions(({ context, enqueue }) => {
      if (!hasPending(context) || context.supportPending) return;
      enqueue.cancel("seat-ready");
      const event = { type: "SEAT_READY", actionId: context.actionId } as const;
      const delay = neutralDelay(
        context.loopTimings.sitting,
        context.now() - context.startedAt,
      );
      if (delay > 0) enqueue.raise(event, { id: "seat-ready", delay });
      // A boundary timer can precede the renderer's rAF. Wait for its frame
      // report rather than spinning a zero-delay timer or cutting the old pose.
      else if (hasPaintedNeutral(context)) enqueue.raise(event);
    }),
    requestIdleExit: enqueueActions(({ context, enqueue }) => {
      if (!hasPending(context) || context.supportPending) return;
      enqueue.cancel("idle-ready");
      const event = { type: "IDLE_READY", actionId: context.actionId } as const;
      const delay = hasExpandedActivities(context.capabilities)
        ? neutralDelay(
            context.loopTimings.resting,
            context.now() - context.startedAt,
          )
        : 0;
      if (delay > 0) enqueue.raise(event, { id: "idle-ready", delay });
      else if (hasPaintedNeutral(context)) enqueue.raise(event);
    }),
  },
}).createMachine({
  id: "pet",
  context: ({ input }) => ({
    now: input.now,
    walkDurationMs: input.walkDurationMs ?? autonomy.walkMs,
    capabilities: input.capabilities,
    loopTimings: input.loopTimings ?? {},
    paintedHandoffs: input.paintedHandoffs ?? false,
    loopFrame: undefined,
    actionId: 0,
    startedAt: input.now(),
    lastClickAt: 0,
    awakeSince: input.now(),
    sleepClickAt: undefined,
    choice: 0,
    direction: "right",
    pendingActivity: undefined,
    pendingCommand: undefined,
    supportPending: false,
    resumeSeat: undefined,
  }),
  initial: "paused",
  on: {
    SUPPORT_PENDING: { actions: "setSupportPending" },
    CANCEL_PLAY: { actions: "clearCommand" },
    CHARACTER: [
      {
        guard: ({ event }) => event.paused,
        target: ".paused",
        actions: [
          "rest",
          "wakeCycle",
          "clearPending",
          "clearSeatResume",
          assign(({ event }) => ({
            walkDurationMs: event.walkDurationMs,
            capabilities: event.capabilities,
            loopTimings: event.loopTimings ?? {},
            paintedHandoffs: event.paintedHandoffs ?? false,
          })),
        ],
      },
      {
        target: ".resting",
        actions: [
          "rest",
          "wakeCycle",
          "clearPending",
          "clearSeatResume",
          assign(({ event }) => ({
            walkDurationMs: event.walkDurationMs,
            capabilities: event.capabilities,
            loopTimings: event.loopTimings ?? {},
            paintedHandoffs: event.paintedHandoffs ?? false,
          })),
        ],
      },
    ],
    FACE: { actions: assign(({ event }) => ({ direction: event.direction })) },
    PLAY: {
      guard: "canPlayStandingAction",
      target: ".continuing",
      actions: ["queuePlay", "wakeCycle"],
    },
    PAUSE: {
      target: ".paused",
      actions: ["rest", "clearPending", "clearSeatResume"],
    },
    RESUME: {
      target: ".resting",
      actions: ["rest", "wakeCycle", "clearPending", "clearSeatResume"],
    },
    CANCEL: {
      target: ".resting",
      actions: ["rest", "wakeCycle", "clearPending", "clearSeatResume"],
    },
    DRAG_START: {
      target: ".dragging",
      actions: ["rest", "wakeCycle", "clearPending", "clearSeatResume"],
    },
    CLIMB: {
      guard: ({ context }) => context.capabilities.includes("climbing"),
      target: ".climbing",
      actions: ["rest", "wakeCycle", "clearActivity", "clearSeatResume"],
    },
    DROP: {
      target: ".falling",
      actions: ["rest", "clearActivity", "clearSeatResume"],
    },
  },
  states: {
    paused: {
      on: {
        PLAY: {},
        PAUSE: [
          { guard: ({ context }) => context.resumeSeat !== undefined },
          { actions: "rest" },
        ],
        // Showing a hidden pet may send CANCEL immediately before RESUME.
        CANCEL: [
          { guard: ({ context }) => context.resumeSeat !== undefined },
          { target: "resting", actions: ["rest", "wakeCycle", "clearPending"] },
        ],
        RESUME: [
          {
            guard: ({ context }) => context.resumeSeat === "sittingdown",
            target: "sittingdown",
            actions: ["rest", "wakeCycle", "queueRest", "clearSeatResume"],
          },
          {
            guard: ({ context }) => context.resumeSeat === "standingup",
            target: "standingup",
            actions: ["rest", "wakeCycle", "queueRest", "clearSeatResume"],
          },
          { target: "resting", actions: ["rest", "wakeCycle", "clearPending"] },
        ],
      },
    },
    autonomous: {
      entry: assign(({ context }) => {
        const choice = Math.random();
        // Keep both draws in the original order even when a stationary daily
        // activity preserves facing, so packs without daily actions are unchanged.
        const direction =
          Math.random() < 0.5 ? ("left" as const) : ("right" as const);
        const daily = dailyActivity({ ...context, choice });
        const walks =
          daily !== undefined
            ? daily === "walking"
            : choice < 0.45 ||
              (!(
                choice < 0.75 && context.capabilities.includes("stretching")
              ) &&
                !context.capabilities.includes("playing"));
        return {
          choice,
          direction:
            hasExpandedActivities(context.capabilities) && !walks
              ? context.direction
              : direction,
        };
      }),
      always: [
        {
          guard: ({ context }) => dailyActivity(context) !== undefined,
          target: "dailyAutonomous",
        },
        {
          guard: ({ context }) => context.choice < 0.45,
          target: "walking",
          actions: "rest",
        },
        {
          guard: ({ context }) =>
            context.choice < 0.75 &&
            context.capabilities.includes("stretching"),
          target: "stretching",
          actions: "rest",
        },
        {
          guard: ({ context }) => context.capabilities.includes("playing"),
          target: "playing",
          actions: "rest",
        },
        { target: "walking", actions: "rest" },
      ],
    },
    dailyAutonomous: {
      always: [
        {
          guard: ({ context }) => dailyActivity(context) === "stretching",
          target: "stretching",
          actions: "rest",
        },
        {
          guard: ({ context }) => dailyActivity(context) === "playing",
          target: "playing",
          actions: "rest",
        },
        {
          guard: ({ context }) => dailyActivity(context) === "looking",
          target: "looking",
          actions: "rest",
        },
        {
          guard: ({ context }) => dailyActivity(context) === "sitting",
          target: "sittingdown",
          actions: "rest",
        },
        {
          guard: ({ context }) => dailyActivity(context) === "yawning",
          target: "yawning",
          actions: "rest",
        },
        {
          guard: ({ context }) => dailyActivity(context) === "grooming",
          target: "grooming",
          actions: "rest",
        },
        {
          guard: ({ context }) => dailyActivity(context) === "habit",
          target: "habit",
          actions: "rest",
        },
        { target: "walking", actions: "rest" },
      ],
    },
    // A single continuation owns commands deferred by sitting or waking. Clear
    // it only after choosing the destination, so stale DONE events cannot replay it.
    continuing: {
      always: [
        {
          guard: ({ context }) => context.supportPending,
          target: "resting",
          actions: "rest",
        },
        {
          guard: ({ context }) =>
            continuation(context) === "stretching" &&
            context.capabilities.includes("stretching"),
          target: "stretching",
          actions: ["rest", "clearPending"],
        },
        {
          guard: ({ context }) => continuation(context) === "autonomous",
          target: "autonomous",
          actions: "clearPending",
        },
        {
          guard: ({ context }) => continuation(context) === "looking",
          target: "looking",
          actions: ["rest", "clearPending"],
        },
        {
          guard: ({ context }) => continuation(context) === "sitting",
          target: "sittingdown",
          actions: ["rest", "clearPending"],
        },
        {
          guard: ({ context }) => continuation(context) === "yawning",
          target: "yawning",
          actions: ["rest", "clearPending"],
        },
        {
          guard: ({ context }) => continuation(context) === "petted",
          target: "petted",
          actions: ["rest", "clearPending"],
        },
        {
          guard: ({ context }) => continuation(context) === "grooming",
          target: "grooming",
          actions: ["rest", "clearPending"],
        },
        {
          guard: ({ context }) => continuation(context) === "celebrating",
          target: "celebrating",
          actions: ["rest", "clearPending"],
        },
        {
          guard: ({ context }) => continuation(context) === "habit",
          target: "habit",
          actions: ["rest", "clearPending"],
        },
        {
          guard: ({ context }) => continuation(context) === "reaction",
          target: "choosing",
          actions: ["begin", "clearPending"],
        },
        {
          guard: ({ context }) => continuation(context) === "climbing",
          target: "climbing",
          actions: ["rest", "clearActivity"],
        },
        {
          guard: ({ context }) => continuation(context) === "sleep",
          target: "settling",
          actions: ["rest", "clearPending"],
        },
        { target: "resting", actions: ["rest", "clearPending"] },
      ],
    },
    walking: {
      after: { walkDuration: { target: "resting", actions: "rest" } },
      on: { CLICK: { target: "choosing", actions: "begin" } },
    },
    stretching: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        CLICK: [
          { guard: "dailyContinuity", actions: ["queueReaction", "wakeCycle"] },
          { target: "choosing", actions: ["begin", "clearPending"] },
        ],
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    playing: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        CLICK: [
          { guard: "dailyContinuity", actions: ["queueReaction", "wakeCycle"] },
          { target: "choosing", actions: ["begin", "clearPending"] },
        ],
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    climbing: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        LANDED: { guard: "currentAction", target: "landing", actions: "rest" },
        CLICK: { target: "choosing", actions: "begin" },
      },
    },
    dragging: {
      on: {
        PLAY: {},
        RELEASE: [
          {
            guard: ({ context }) => context.capabilities.includes("flutter"),
            target: "flutter",
            actions: "rest",
          },
          { target: "falling", actions: "rest" },
        ],
      },
    },
    flutter: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        DONE: { guard: "currentAction", target: "falling", actions: "rest" },
      },
    },
    falling: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        LANDED: { guard: "currentAction", target: "landing", actions: "rest" },
      },
    },
    landing: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    settling: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          target: "waking",
          actions: ["rest", "queuePlay", "wakeCycle"],
        },
        DONE: { guard: "currentAction", target: "sleeping", actions: "rest" },
        CLICK: { target: "waking", actions: ["rest", "wakeCycle"] },
      },
    },
    sleeping: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          target: "waking",
          actions: ["rest", "queuePlay", "wakeCycle"],
        },
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
        PLAY: {
          guard: "canPlayStandingAction",
          target: "waking",
          actions: ["rest", "queuePlay", "wakeCycle"],
        },
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
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        DONE: {
          guard: "currentAction",
          target: "continuing",
          actions: "wakeCycle",
        },
      },
    },
    resting: {
      exit: cancel("idle-ready"),
      after: {
        restDelay: [
          { guard: ({ context }) => context.pendingActivity !== undefined },
          {
            guard: "dailyContinuity",
            actions: ["queueIdleActivity", "requestIdleExit"],
          },
          { guard: "readyToSleep", target: "settling", actions: "rest" },
          { target: "autonomous" },
        ],
      },
      on: {
        SUPPORT_PENDING: { actions: ["setSupportPending", "requestIdleExit"] },
        LOOP_FRAME: {
          guard: "currentLoopFrame",
          actions: ["recordLoopFrame", "requestIdleExit"],
        },
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle", "requestIdleExit"],
        },
        CLICK: [
          {
            guard: ({ context }) =>
              context.now() - context.lastClickAt >= clickMergeIntervalMs &&
              hasExpandedActivities(context.capabilities) &&
              context.loopTimings.resting !== undefined,
            actions: ["queueReaction", "wakeCycle", "requestIdleExit"],
          },
          { guard: "freshClick", target: "choosing", actions: "begin" },
        ],
        IDLE_READY: [
          {
            guard: ({ context, event }) =>
              event.actionId === context.actionId &&
              hasPending(context) &&
              !context.supportPending &&
              hasPaintedNeutral(context) &&
              neutralDelay(
                context.loopTimings.resting,
                context.now() - context.startedAt,
              ) === 0,
            target: "continuing",
          },
          { guard: "currentLoopRequest", actions: "requestIdleExit" },
        ],
      },
    },
    choosing: {
      entry: assign(() => ({ choice: Math.random() })),
      always: [
        {
          guard: ({ context }) => reaction(context) === "petted",
          target: "petted",
        },
        {
          guard: ({ context }) => reaction(context) === "tilt",
          target: "tilt",
        },
        { guard: ({ context }) => reaction(context) === "paw", target: "paw" },
        {
          guard: ({ context }) => reaction(context) === "belly",
          target: "belly",
        },
        { target: "resting", actions: "rest" },
      ],
    },
    tilt: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    paw: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    belly: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    looking: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        CLICK: { actions: ["queueReaction", "wakeCycle"] },
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    yawning: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        CLICK: { actions: ["queueReaction", "wakeCycle"] },
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    petted: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    grooming: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        CLICK: { actions: ["queueReaction", "wakeCycle"] },
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    celebrating: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        CLICK: { actions: ["queueReaction", "wakeCycle"] },
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    habit: {
      on: {
        PLAY: {
          guard: "canPlayStandingAction",
          actions: ["queuePlay", "wakeCycle"],
        },
        CLICK: { actions: ["queueReaction", "wakeCycle"] },
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
    sittingdown: {
      on: {
        PLAY: [
          { guard: ({ event }) => event.action === "sitting" },
          { guard: "canPlay", actions: ["queuePlay", "wakeCycle"] },
        ],
        CLICK: { actions: ["queueReaction", "wakeCycle"] },
        CANCEL: { actions: ["queueRest", "wakeCycle"] },
        RESUME: {},
        CLIMB: {
          guard: ({ context }) => context.capabilities.includes("climbing"),
          actions: ["queueClimb", "wakeCycle"],
        },
        PAUSE: {
          target: "paused",
          actions: ["rest", "clearPending", "pauseSittingDown"],
        },
        DONE: [
          {
            guard: ({ context, event }) =>
              event.actionId === context.actionId && hasPending(context),
            target: "standingup",
            actions: "rest",
          },
          { guard: "currentAction", target: "sitting", actions: "rest" },
        ],
      },
    },
    sitting: {
      exit: cancel("seat-ready"),
      after: {
        sittingDuration: [
          { guard: ({ context }) => context.pendingActivity !== undefined },
          {
            guard: "readyToSleep",
            actions: ["queueSleep", "requestSeatExit"],
          },
          { actions: ["queueAutomaticRest", "requestSeatExit"] },
        ],
      },
      on: {
        SUPPORT_PENDING: { actions: ["setSupportPending", "requestSeatExit"] },
        LOOP_FRAME: {
          guard: "currentLoopFrame",
          actions: ["recordLoopFrame", "requestSeatExit"],
        },
        PLAY: [
          { guard: ({ event }) => event.action === "sitting" },
          {
            guard: "canPlay",
            actions: ["queuePlay", "wakeCycle", "requestSeatExit"],
          },
        ],
        CLICK: {
          actions: ["queueReaction", "wakeCycle", "requestSeatExit"],
        },
        CANCEL: {
          actions: ["queueRest", "wakeCycle", "requestSeatExit"],
        },
        RESUME: {},
        CLIMB: {
          guard: ({ context }) => context.capabilities.includes("climbing"),
          actions: ["queueClimb", "wakeCycle", "requestSeatExit"],
        },
        PAUSE: {
          target: "paused",
          actions: ["rest", "clearPending", "pauseSeated"],
        },
        SEAT_READY: [
          {
            guard: ({ context, event }) =>
              event.actionId === context.actionId &&
              hasPending(context) &&
              !context.supportPending &&
              hasPaintedNeutral(context) &&
              neutralDelay(
                context.loopTimings.sitting,
                context.now() - context.startedAt,
              ) === 0,
            target: "standingup",
            actions: "rest",
          },
          { guard: "currentLoopRequest", actions: "requestSeatExit" },
        ],
      },
    },
    standingup: {
      on: {
        PLAY: { guard: "canPlay", actions: ["queuePlay", "wakeCycle"] },
        CLICK: { actions: ["queueReaction", "wakeCycle"] },
        CANCEL: { actions: ["queueRest", "wakeCycle"] },
        RESUME: {},
        CLIMB: {
          guard: ({ context }) => context.capabilities.includes("climbing"),
          actions: ["queueClimb", "wakeCycle"],
        },
        PAUSE: {
          target: "paused",
          actions: ["rest", "clearPending", "pauseSeated"],
        },
        DONE: { guard: "currentAction", target: "continuing" },
      },
    },
  },
});
