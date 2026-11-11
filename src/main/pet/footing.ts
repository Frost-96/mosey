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

export function createFooting(adapter: FootingAdapter) {
  const floor = () => {
    const area = adapter.workArea();
    return area.y + area.height;
  };

  const supportAt = (
    body: FootingBody,
    position: { x: number; y: number },
    dock: DockSurface | null,
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
  const alignGround = (body: FootingBody, dock: DockSurface | null) => {
    const bounds = adapter.windowBounds();
    const support = supportAt(body, { x: bounds.x, y: bounds.y }, dock);
    constrain(
      bounds.x + support.shiftX,
      Math.min(floor(), support.footY) - bounds.height,
    );
  };

  return { supportAt, constrain, alignGround };
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
