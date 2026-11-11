import { dockSupport, type DockSurface } from "../../behavior/dock-support.ts";
import type { Atlas } from "../../shared/assets.ts";
import type { CharacterCapability } from "../../shared/character-capabilities.ts";
import type { characterGeometry } from "../../shared/character-geometry.ts";
import type { PetSize } from "../../shared/size.ts";

// Footing answers where the pet's feet are supported. It is the one seam for
// support rules, so the session, motion, interaction and character switch can
// ask it instead of reading support through each other's closures. The module never imports
// Electron and never holds character state; callers describe the body on each
// call (the current character, or a switch candidate alike). Time, window
// bounds, window placement and the work area come only through the adapter
// passed at construction: the Electron adapter in production, the in-memory
// adapter in tooling tests, so support rules are verified without a desktop.
// It also owns the Dock observation and its bounded pending hold, and decides
// whether to climb, drop or stay. It never sends behavior events: callers act
// on the returned decision, so the behavior machine stays independent of it.

type Rect = { x: number; y: number; width: number; height: number };

export type FootingAdapter = {
  now(): number;
  // Returns a cancel operation; the callback never runs after cancellation.
  schedule(delayMs: number, callback: () => void): () => void;
  windowBounds(): Rect;
  setWindowPosition(x: number, y: number): void;
  workArea(): Rect;
};

// Everything the rules need to know about one body, as painted right now.
export type FootingBody = {
  geometry: Pick<ReturnType<typeof characterGeometry>, "frame" | "contactAt">;
  capabilities: readonly CharacterCapability[];
  size: PetSize;
  posture: Atlas["action"];
  frame: number;
  direction: "left" | "right";
  // The body's present foot line, independent of a queried position.
  footY: number;
};

export type Support = { footY: number; shiftX: number };

export type DockDecision = {
  move: "climb" | "drop" | "stay";
  // Side avoidance for the caller to apply before the move.
  shiftX: number;
};

// A new complete frame invalidates the old edge immediately. Movement holds
// while its worker finishes, never moving on that old geometry; the bound keeps
// a stuck producer from turning the hold into a permanent one.
const dockHoldMs = 250;

export function createFooting(
  adapter: FootingAdapter,
  options: {
    // The clock motion is timed by. A hold freezes it and later subtracts the
    // held duration; it may pause independently of the adapter's time.
    movementClock?: () => number;
    // A hold ended by its bound rather than by a completed frame.
    holdEnded?: () => void;
  } = {},
) {
  const movementClock = options.movementClock ?? adapter.now;
  let dock: DockSurface | null = null;
  // Only an observed overlapping bottom edge owns vertical support. A null or
  // pending capture report cannot turn an unrelated desktop position into a drop.
  let supported = false;
  let pendingSince: number | undefined;
  let heldAt: number | undefined;
  let heldDuration = 0;
  let cancelHold: (() => void) | undefined;

  const floor = () => {
    const area = adapter.workArea();
    return area.y + area.height;
  };

  const endHold = () => {
    if (heldAt !== undefined) heldDuration += movementClock() - heldAt;
    heldAt = undefined;
    cancelHold?.();
    cancelHold = undefined;
  };

  // Returns whether support may have changed, so the caller should reconcile.
  const observe = (observation: DockSurface | null, pending: boolean) => {
    const changed = dock !== null || observation !== null;
    const wasHeld = heldAt !== undefined;
    dock = observation;
    if (pending) {
      pendingSince ??= adapter.now();
      if (adapter.now() - pendingSince < dockHoldMs && heldAt === undefined) {
        heldAt = movementClock();
        cancelHold = adapter.schedule(dockHoldMs, () => {
          endHold();
          options.holdEnded?.();
        });
      }
    } else {
      pendingSince = undefined;
      endHold();
    }
    // Repeated unavailable reports do not own desktop placement. Only a
    // capability change (or an ended pending frame) may initiate Dock motion.
    return changed || (wasHeld && !pending);
  };

  const supportAt = (
    body: FootingBody,
    position: { x: number; y: number },
  ): Support => {
    const ground = floor();
    const bounds = body.geometry
      .frame({
        posture: body.posture,
        frame: body.frame,
        direction: body.direction,
        size: body.size,
      })
      ?.boundsAt(position);
    if (!bounds) return { footY: ground, shiftX: 0 };
    if (dock?.orientation === "bottom") {
      const contact = body.geometry.contactAt(body.size, position.x);
      if (!contact) return { footY: ground, shiftX: 0 };
      bounds.left = contact.left;
      bounds.right = contact.right;
    }
    const support = dockSupport(dock, bounds, ground);
    // A character without climbing can land on a lower Dock edge, but must not
    // be pulled up through it when the edge rises or appears above its feet.
    if (
      !body.capabilities.includes("climbing") &&
      support.footY < body.footY - 1
    )
      return { footY: ground, shiftX: support.shiftX };
    return support;
  };

  // Keep the whole window inside the work area, in whole desktop points.
  const constrain = (x: number, y: number) => {
    const area = adapter.workArea();
    const bounds = adapter.windowBounds();
    adapter.setWindowPosition(
      Math.round(
        Math.max(
          area.x,
          Math.min(x, area.x + Math.max(0, area.width - bounds.width)),
        ),
      ),
      Math.round(
        Math.max(
          area.y,
          Math.min(y, area.y + Math.max(0, area.height - bounds.height)),
        ),
      ),
    );
  };

  // Place the window's foot on its current support without other motion.
  const alignGround = (body: FootingBody) => {
    const bounds = adapter.windowBounds();
    const support = supportAt(body, { x: bounds.x, y: bounds.y });
    constrain(
      bounds.x + support.shiftX,
      Math.min(floor(), support.footY) - bounds.height,
    );
  };

  // Decide how the window at its current position follows the observed Dock.
  // Only call while the pet may move; each call consumes a lost-support edge.
  const reconcile = (body: FootingBody): DockDecision => {
    if (heldAt !== undefined) return { move: "stay", shiftX: 0 };
    const bounds = adapter.windowBounds();
    const support = supportAt(body, { x: bounds.x, y: bounds.y });
    const nowSupported = support.footY < floor() - 1;
    const lostSupport = supported && !nowSupported;
    supported = nowSupported;
    const footY = bounds.y + bounds.height;
    const move =
      (!nowSupported && !lostSupport) || Math.abs(support.footY - footY) <= 1
        ? "stay"
        : support.footY < footY
          ? "climb"
          : "drop";
    return { move, shiftX: support.shiftX };
  };

  // Forget the Dock entirely while the pet cannot be observed.
  const reset = () => {
    supported = false;
    pendingSince = undefined;
    endHold();
    dock = null;
  };

  return {
    observe,
    reconcile,
    reset,
    endHold,
    get holding() {
      return heldAt !== undefined;
    },
    // Motion time, standing still while a pending Dock frame holds movement.
    movementNow: () => (heldAt ?? movementClock()) - heldDuration,
    supportAt,
    constrain,
    alignGround,
  };
}

export type Footing = ReturnType<typeof createFooting>;

// Deterministic adapter for tests: a manual clock and one plain window.
export function createMemoryFootingAdapter(initial: {
  window: Rect;
  workArea: Rect;
  now?: number;
}) {
  let now = initial.now ?? 0;
  let window = { ...initial.window };
  let area = { ...initial.workArea };
  let tasks: { at: number; callback: () => void }[] = [];
  const adapter: FootingAdapter & {
    advance(ms: number): void;
    setWindow(rect: Rect): void;
    setWorkArea(rect: Rect): void;
  } = {
    now: () => now,
    schedule(delayMs, callback) {
      const task = { at: now + delayMs, callback };
      tasks.push(task);
      return () => {
        tasks = tasks.filter((item) => item !== task);
      };
    },
    windowBounds: () => ({ ...window }),
    setWindowPosition(x, y) {
      window = { ...window, x, y };
    },
    workArea: () => ({ ...area }),
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = tasks
          .filter((task) => task.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        tasks = tasks.filter((task) => task !== due);
        now = due.at;
        due.callback();
      }
      now = target;
    },
    setWindow(rect) {
      window = { ...rect };
    },
    setWorkArea(rect) {
      area = { ...rect };
    },
  };
  return adapter;
}
