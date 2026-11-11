import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import type { DockSurface } from "../src/behavior/dock-support.ts";
import {
  createFooting,
  createMemoryFootingAdapter,
  type FootingBody,
} from "../src/main/pet/footing.ts";

// Footing is verified only through its interface, with the in-memory adapter.
// A 1000x800 work area at the origin; the pet window is 100 points square and
// its painted body spans 30..70 horizontally and 20..100 vertically.
const workArea = { x: 0, y: 0, width: 1000, height: 800 };
const floor = 800;

function fixture(window = { x: 400, y: 700, width: 100, height: 100 }) {
  const adapter = createMemoryFootingAdapter({ window, workArea });
  const holdsEnded: number[] = [];
  const footing = createFooting(adapter, {
    holdEnded: () => holdsEnded.push(adapter.now()),
  });
  return { adapter, footing, holdsEnded };
}

function body(overrides: Partial<FootingBody> = {}): FootingBody {
  return {
    geometry: {
      frame: (pose) => ({
        drawing: {
          image: "",
          source: { x: 0, y: 0, width: 0, height: 0 },
          transform: [1, 0, 0, 1, 0, 0],
        },
        contains: () => true,
        boundsAt: (origin) => ({
          left: origin.x + 30,
          right: origin.x + 70,
          top: origin.y + 20,
          bottom: origin.y + pose.size,
        }),
      }),
      contactAt: (_size, x) => ({ left: x + 40, right: x + 60 }),
    },
    capabilities: ["climbing"],
    size: 100,
    posture: "resting",
    frame: 0,
    direction: "right",
    footY: floor,
    ...overrides,
  };
}

const bottomDock = (top: number, from = 300, to = 700): DockSurface => ({
  orientation: "bottom",
  contour: Array.from({ length: (to - from) / 10 + 1 }, (_, index) => ({
    axis: from + index * 10,
    inward: top,
  })),
});

const sideDock = (orientation: "left" | "right", inward: number) => ({
  orientation,
  contour: Array.from({ length: 81 }, (_, index) => ({
    axis: index * 10,
    inward,
  })),
});

test("footing never imports Electron, directly or through its imports", () => {
  const seen = new Set<string>();
  const visit = (url: URL) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const imports = ts.preProcessFile(readFileSync(url, "utf8"), true, true);
    for (const { fileName } of imports.importedFiles) {
      assert.ok(
        fileName !== "electron" && !fileName.startsWith("electron/"),
        `${url.pathname} imports ${fileName}`,
      );
      if (fileName.startsWith("."))
        visit(
          new URL(fileName.endsWith(".ts") ? fileName : `${fileName}.ts`, url),
        );
    }
  };
  visit(new URL("../src/main/pet/footing.ts", import.meta.url));
});

test("without an observed Dock the pet returns to the work-area bottom", () => {
  const { adapter, footing } = fixture({
    x: 400,
    y: 300,
    width: 100,
    height: 100,
  });
  assert.deepEqual(footing.supportAt(body(), { x: 400, y: 300 }), {
    footY: floor,
    shiftX: 0,
  });
  footing.alignGround(body({ footY: 400 }));
  assert.deepEqual(adapter.windowBounds(), {
    x: 400,
    y: floor - 100,
    width: 100,
    height: 100,
  });
});

test("an overlapping bottom Dock supports the pet on its top edge", () => {
  const { adapter, footing } = fixture();
  footing.observe(bottomDock(740), false);
  assert.deepEqual(footing.supportAt(body(), { x: 400, y: 700 }), {
    footY: 740,
    shiftX: 0,
  });
  footing.alignGround(body());
  assert.equal(adapter.windowBounds().y, 640);
  // Beyond the Dock's extent the contact no longer overlaps: back to floor.
  assert.equal(footing.supportAt(body(), { x: 800, y: 700 }).footY, floor);
});

test("left and right Docks are avoided horizontally, never stood on", () => {
  const { adapter, footing } = fixture({
    x: 0,
    y: 700,
    width: 100,
    height: 100,
  });
  // The body's left edge is at 30; a left Dock reaching 80 shifts it clear.
  footing.observe(sideDock("left", 80), false);
  assert.deepEqual(footing.supportAt(body(), { x: 0, y: 700 }), {
    footY: floor,
    shiftX: 52,
  });
  footing.alignGround(body());
  assert.deepEqual(adapter.windowBounds(), {
    x: 52,
    y: 700,
    width: 100,
    height: 100,
  });
  // The body's right edge is at 970; a right Dock from 920 shifts it back.
  footing.observe(sideDock("right", 920), false);
  assert.deepEqual(footing.supportAt(body(), { x: 900, y: 700 }), {
    footY: floor,
    shiftX: -52,
  });
});

test("a character without climbing is never pulled up by a Dock edge", () => {
  const { footing } = fixture();
  footing.observe(bottomDock(740), false);
  const walker = body({ capabilities: [] });
  // Feet on the floor, Dock edge above them: stays on the floor.
  assert.equal(footing.supportAt(walker, { x: 400, y: 700 }).footY, floor);
  // Feet above the edge (e.g. released from a drag): it may land on it.
  assert.equal(
    footing.supportAt({ ...walker, footY: 600 }, { x: 400, y: 500 }).footY,
    740,
  );
  // A climbing character rises to the same edge from the floor.
  assert.equal(footing.supportAt(body(), { x: 400, y: 700 }).footY, 740);
});

test("placement is clamped inside the work area in whole points", () => {
  const { adapter, footing } = fixture();
  footing.constrain(-20.4, 900);
  assert.deepEqual(adapter.windowBounds(), {
    x: 0,
    y: 700,
    width: 100,
    height: 100,
  });
  footing.constrain(950.6, 120.4);
  assert.deepEqual(adapter.windowBounds(), {
    x: 900,
    y: 120,
    width: 100,
    height: 100,
  });
});

test("a pending Dock frame holds movement for at most 250 ms", () => {
  const { adapter, footing, holdsEnded } = fixture();
  footing.observe(bottomDock(740), true);
  assert.equal(footing.holding, true);
  adapter.advance(249);
  assert.equal(footing.holding, true);
  assert.deepEqual(holdsEnded, []);
  adapter.advance(1);
  assert.equal(footing.holding, false);
  assert.deepEqual(holdsEnded, [250]);
  // A producer still reporting the same pending frame cannot extend the hold.
  assert.equal(footing.observe(bottomDock(740), true), true);
  assert.equal(footing.holding, false);
  adapter.advance(1000);
  assert.deepEqual(holdsEnded, [250]);
  // A completed frame closes that pending run; the next one may hold again.
  footing.observe(bottomDock(740), false);
  footing.observe(bottomDock(740), true);
  assert.equal(footing.holding, true);
  adapter.advance(250);
  assert.deepEqual(holdsEnded, [250, 1500]);
});

test("a completed frame ends the hold early and asks for reconciliation", () => {
  const { adapter, footing, holdsEnded } = fixture();
  footing.observe(null, true);
  adapter.advance(100);
  assert.equal(footing.observe(null, false), true);
  assert.equal(footing.holding, false);
  adapter.advance(1000);
  // Ended by the report, not by the bound: no late notification.
  assert.deepEqual(holdsEnded, []);
});

test("movement time stands still for exactly the held duration", () => {
  const { adapter, footing } = fixture();
  adapter.advance(1000);
  assert.equal(footing.movementNow(), 1000);
  footing.observe(bottomDock(740), true);
  adapter.advance(100);
  assert.equal(footing.movementNow(), 1000);
  footing.observe(bottomDock(740), false);
  assert.equal(footing.movementNow(), 1000);
  adapter.advance(50);
  assert.equal(footing.movementNow(), 1050);
  footing.observe(bottomDock(740), true);
  adapter.advance(400);
  // The bound ended this hold after 250 ms; time moves again from there.
  assert.equal(footing.movementNow(), 1200);
});

test("movement time follows the supplied movement clock", () => {
  const adapter = createMemoryFootingAdapter({
    window: { x: 400, y: 700, width: 100, height: 100 },
    workArea,
  });
  let movement = 5000;
  const footing = createFooting(adapter, { movementClock: () => movement });
  footing.observe(null, true);
  movement += 30;
  adapter.advance(100);
  // The hold is bounded in adapter time but measured in movement time.
  footing.observe(null, false);
  movement += 10;
  assert.equal(footing.movementNow(), 5010);
});

test("while a frame is pending the pet stays, whatever the old edge says", () => {
  const { adapter, footing } = fixture();
  footing.observe(bottomDock(740), true);
  assert.deepEqual(footing.reconcile(body()), { move: "stay", shiftX: 0 });
  adapter.advance(250);
  // Once the bound has passed the observed edge is used.
  assert.deepEqual(footing.reconcile(body()), { move: "climb", shiftX: 0 });
});

test("a Dock edge above the feet climbs; a lowered edge drops", () => {
  const { adapter, footing } = fixture();
  footing.observe(bottomDock(740), false);
  assert.deepEqual(footing.reconcile(body()), { move: "climb", shiftX: 0 });
  // Reconciliation only decides; the window has not moved.
  assert.equal(adapter.windowBounds().y, 700);
  adapter.setWindow({ x: 400, y: 640, width: 100, height: 100 });
  assert.deepEqual(footing.reconcile(body({ footY: 740 })), {
    move: "stay",
    shiftX: 0,
  });
  footing.observe(bottomDock(760), false);
  assert.deepEqual(footing.reconcile(body({ footY: 740 })), {
    move: "drop",
    shiftX: 0,
  });
});

test("losing Dock support drops once; unsupported positions are left alone", () => {
  const { adapter, footing } = fixture({
    x: 400,
    y: 640,
    width: 100,
    height: 100,
  });
  const standing = body({ footY: 740 });
  footing.observe(bottomDock(740), false);
  assert.equal(footing.reconcile(standing).move, "stay");
  footing.observe(null, false);
  assert.equal(footing.reconcile(standing).move, "drop");
  // The edge was consumed: a pet still above the floor is not dropped again.
  assert.equal(footing.reconcile(standing).move, "stay");
  // Without prior Dock support, a raised position never becomes a drop.
  const fresh = fixture({ x: 400, y: 300, width: 100, height: 100 });
  assert.equal(fresh.footing.reconcile(body({ footY: 400 })).move, "stay");
  assert.equal(fresh.adapter.windowBounds().y, 300);
  assert.equal(adapter.windowBounds().y, 640);
});

test("side Dock avoidance is returned as a shift for the caller to apply", () => {
  const { adapter, footing } = fixture({
    x: 0,
    y: 700,
    width: 100,
    height: 100,
  });
  footing.observe(sideDock("left", 80), false);
  assert.deepEqual(footing.reconcile(body()), { move: "stay", shiftX: 52 });
  assert.equal(adapter.windowBounds().x, 0);
});

test("repeated unavailable reports never ask for movement", () => {
  const { footing } = fixture({ x: 400, y: 300, width: 100, height: 100 });
  assert.equal(footing.observe(null, false), false);
  assert.equal(footing.observe(null, false), false);
  // Even if reconciled anyway, a raised pet is not moved by them.
  assert.deepEqual(footing.reconcile(body({ footY: 400 })), {
    move: "stay",
    shiftX: 0,
  });
  assert.equal(footing.observe(bottomDock(740), false), true);
  // Losing a previously observed Dock is a change worth reconciling.
  assert.equal(footing.observe(null, false), true);
  assert.equal(footing.observe(null, false), false);
});

test("reset forgets the observation, support and any hold", () => {
  const { adapter, footing, holdsEnded } = fixture({
    x: 400,
    y: 640,
    width: 100,
    height: 100,
  });
  footing.observe(bottomDock(740), false);
  assert.equal(footing.reconcile(body({ footY: 740 })).move, "stay");
  footing.observe(bottomDock(740), true);
  footing.reset();
  assert.equal(footing.holding, false);
  adapter.advance(1000);
  assert.deepEqual(holdsEnded, []);
  // The forgotten support is not "lost": an unrelated report cannot drop it.
  assert.equal(footing.observe(null, false), false);
  assert.equal(footing.reconcile(body({ footY: 740 })).move, "stay");
  // The pending run was forgotten too, so a new frame may hold again.
  footing.observe(null, true);
  assert.equal(footing.holding, true);
});

test("the in-memory adapter runs scheduled work in time order", () => {
  const { adapter } = fixture();
  const ran: string[] = [];
  adapter.schedule(250, () => ran.push("late"));
  const cancel = adapter.schedule(100, () => ran.push("cancelled"));
  adapter.schedule(50, () => ran.push("early"));
  cancel();
  adapter.advance(200);
  assert.deepEqual(ran, ["early"]);
  assert.equal(adapter.now(), 200);
  adapter.advance(50);
  assert.deepEqual(ran, ["early", "late"]);
});
