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
  return { adapter, footing: createFooting(adapter) };
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
  assert.deepEqual(footing.supportAt(body(), { x: 400, y: 300 }, null), {
    footY: floor,
    shiftX: 0,
  });
  footing.alignGround(body({ footY: 400 }), null);
  assert.deepEqual(adapter.windowBounds(), {
    x: 400,
    y: floor - 100,
    width: 100,
    height: 100,
  });
});

test("an overlapping bottom Dock supports the pet on its top edge", () => {
  const { adapter, footing } = fixture();
  const dock = bottomDock(740);
  assert.deepEqual(footing.supportAt(body(), { x: 400, y: 700 }, dock), {
    footY: 740,
    shiftX: 0,
  });
  footing.alignGround(body(), dock);
  assert.equal(adapter.windowBounds().y, 640);
  // Beyond the Dock's extent the contact no longer overlaps: back to floor.
  assert.equal(
    footing.supportAt(body(), { x: 800, y: 700 }, dock).footY,
    floor,
  );
});

test("left and right Docks are avoided horizontally, never stood on", () => {
  const { adapter, footing } = fixture({
    x: 0,
    y: 700,
    width: 100,
    height: 100,
  });
  // The body's left edge is at 30; a left Dock reaching 80 shifts it clear.
  assert.deepEqual(
    footing.supportAt(body(), { x: 0, y: 700 }, sideDock("left", 80)),
    { footY: floor, shiftX: 52 },
  );
  footing.alignGround(body(), sideDock("left", 80));
  assert.deepEqual(adapter.windowBounds(), {
    x: 52,
    y: 700,
    width: 100,
    height: 100,
  });
  // The body's right edge is at 970; a right Dock from 920 shifts it back.
  assert.deepEqual(
    footing.supportAt(body(), { x: 900, y: 700 }, sideDock("right", 920)),
    { footY: floor, shiftX: -52 },
  );
});

test("a character without climbing is never pulled up by a Dock edge", () => {
  const { footing } = fixture();
  const dock = bottomDock(740);
  const walker = body({ capabilities: [] });
  // Feet on the floor, Dock edge above them: stays on the floor.
  assert.equal(
    footing.supportAt(walker, { x: 400, y: 700 }, dock).footY,
    floor,
  );
  // Feet above the edge (e.g. released from a drag): it may land on it.
  assert.equal(
    footing.supportAt({ ...walker, footY: 600 }, { x: 400, y: 500 }, dock)
      .footY,
    740,
  );
  // A climbing character rises to the same edge from the floor.
  assert.equal(footing.supportAt(body(), { x: 400, y: 700 }, dock).footY, 740);
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
