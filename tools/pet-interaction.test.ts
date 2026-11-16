import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import type { BrowserWindow } from "electron";
import ts from "typescript";
import { createActor } from "xstate";
import { petBehavior } from "../src/behavior/pet-machine.ts";
import { Timeline } from "../src/behavior/timeline.ts";
import {
  createFooting,
  createMemoryFootingAdapter,
} from "../src/main/pet/footing.ts";
import {
  createMemoryPresenceAdapter,
  createPresence,
} from "../src/main/pet/presence.ts";
import type { createPetInteraction } from "../src/main/pet/interaction.ts";

// Execute the actual adapter with small native-boundary substitutes. No Electron
// process is launched; behavior, delayed events and the active-time clock are real.
const adapter = ts.transpileModule(
  readFileSync(
    new URL("../src/main/pet/interaction.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

// A 1000x800 work area at the origin holds the 240-point pet window, whose
// painted body spans its middle half horizontally and its whole height.
const workArea = { x: 0, y: 0, width: 1000, height: 800 };

class PetWindow extends EventEmitter {
  destroyed = false;
  webContents = { mainFrame: {}, send() {} };
  getBounds: () => object;
  constructor(window: { windowBounds(): object }) {
    super();
    this.getBounds = () => window.windowBounds();
  }
  // Whether clicks pass through the window, as the pointer poll last set it.
  ignoring = true;
  isDestroyed = () => this.destroyed;
  setIgnoreMouseEvents(ignore: boolean) {
    this.ignoring = ignore;
  }
}
class NativeMenu extends EventEmitter {
  callback: (() => void) | undefined;
  popup(options: { callback: () => void }) {
    this.callback = options.callback;
  }
  closePopup() {
    this.callback?.();
  }
}

function harness(t: TestContext, daily = true) {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1000,
  });
  const timeline = new Timeline();
  const loopTimings = daily
    ? { resting: { durationMs: 2000, neutralMs: 300 } }
    : undefined;
  const actor = createActor(petBehavior, {
    clock: timeline,
    input: {
      now: timeline.now,
      capabilities: daily ? ["looking"] : [],
      loopTimings,
      paintedHandoffs: daily,
    },
  }).start();
  actor.send({ type: "RESUME" });
  const window = createMemoryFootingAdapter({
    window: { x: 400, y: 560, width: 240, height: 240 },
    workArea,
  });
  const footing = createFooting(window);
  const pet = new PetWindow(window);
  // A loaded renderer in a shown window: the pet starts observed.
  const lifecycle = createMemoryPresenceAdapter();
  const presence = createPresence(lifecycle, {
    notify() {},
    prepareShow() {},
  });
  void presence.load();
  lifecycle.finishLoad();
  assert.equal(presence.observable, true);
  const environment = {
    geometryRevision: 1,
    size: 240,
    character: {
      id: daily ? "gpt" : "corgi",
      resourceVersion: "version-a",
      loopTimings,
      atlases: [{ action: "resting", frames: [{}, {}, {}, {}] }],
      capabilities: daily ? ["looking"] : [],
      geometry: {
        frame: () => ({
          contains: () => true,
          boundsAt: (origin: { x: number; y: number }) => ({
            left: origin.x + 60,
            right: origin.x + 180,
            top: origin.y,
            bottom: origin.y + 240,
          }),
        }),
        contactAt: (_size: number, x: number) => ({
          left: x + 60,
          right: x + 180,
        }),
      },
    },
    stopMotion() {},
    publish() {},
    bodyMenu: () => [],
  };
  const menus: NativeMenu[] = [];
  const event = {
    sender: pet.webContents,
    senderFrame: pet.webContents.mainFrame,
  };
  let receive: ((ipcEvent: typeof event, value: unknown) => void) | undefined;
  const exports: { createPetInteraction?: typeof createPetInteraction } = {};
  new Function("require", "exports", adapter)((specifier: string) => {
    if (specifier === "electron")
      return {
        app: { focus() {} },
        screen: { getCursorScreenPoint: () => ({ x: 120, y: 120 }) },
        Menu: {
          buildFromTemplate() {
            const menu = new NativeMenu();
            menus.push(menu);
            return menu;
          },
        },
        ipcMain: {
          on(_channel: string, callback: typeof receive) {
            receive = callback;
          },
        },
      };
    if (specifier === "electron-log/main") return { default: { error() {} } };
    if (specifier === "../../shared/contract")
      return {
        channels: { input: "input", gestureCancellation: "cancel" },
        // Inputs below already have the contract shape; authentication, current
        // action, geometry, frame bounds and lifecycle checks remain the real code.
        inputSchema: {
          safeParse: (data: unknown) => ({ success: true, data }),
        },
      };
    throw new Error(`Unexpected adapter import: ${specifier}`);
  }, exports);
  assert.ok(exports.createPetInteraction);
  const interaction = exports.createPetInteraction(
    pet as unknown as BrowserWindow,
    actor,
    timeline,
    footing,
    presence,
    environment as unknown as Parameters<typeof createPetInteraction>[5],
  );
  t.after(() => {
    actor.stop();
    interaction.stopPolling();
    t.mock.timers.reset();
  });
  const input = (value: Record<string, unknown>) => {
    assert.ok(receive);
    receive(event, value);
  };
  const frame = (index: number) =>
    input({
      type: "frame",
      geometryRevision: environment.geometryRevision,
      actionId: actor.getSnapshot().context.actionId,
      frame: index,
    });
  const openAtBoundary = () => {
    frame(0);
    t.mock.timers.tick(1990);
    frame(3);
    t.mock.timers.tick(10);
    input({
      type: "context",
      geometryRevision: environment.geometryRevision,
      actionId: actor.getSnapshot().context.actionId,
      x: 120,
      y: 120,
    });
    assert.equal(interaction.menuOpen, true);
  };
  return {
    actor,
    timeline,
    pet,
    window,
    footing,
    lifecycle,
    presence,
    environment,
    interaction,
    menus,
    input,
    frame,
    openAtBoundary,
  };
}

test("menu keeps neutral handoffs and action completion live without replay on close", (t) => {
  const h = harness(t);
  h.openAtBoundary();
  h.actor.send({ type: "PLAY", action: "looking" });
  h.frame(0);
  assert.equal(h.interaction.displayed?.frame, 0);
  assert.equal(h.actor.getSnapshot().value, "looking");
  assert.equal(h.timeline.pausedAt, undefined);
  h.input({ type: "done", actionId: h.actor.getSnapshot().context.actionId });
  assert.equal(h.actor.getSnapshot().value, "resting");
  const completed = h.actor.getSnapshot().context.actionId;
  h.menus[0].closePopup();
  assert.equal(h.actor.getSnapshot().context.actionId, completed);
  assert.equal(h.interaction.menuOpen, false);
});

for (const invalidation of [
  "geometry",
  "not-ready",
  "hidden",
  "suspended",
  "action",
] as const) {
  test(`menu rejects stale paint after ${invalidation} changes without buffering it`, (t) => {
    const h = harness(t);
    h.openAtBoundary();
    const actionId = h.actor.getSnapshot().context.actionId;
    if (invalidation === "geometry") h.environment.geometryRevision++;
    // A reload retires the renderer and hides the pet before the new page.
    if (invalidation === "not-ready") void h.presence.load();
    if (invalidation === "hidden") h.lifecycle.hide();
    if (invalidation === "suspended") h.lifecycle.suspend();
    if (invalidation === "action") h.actor.send({ type: "CANCEL" });
    h.input({ type: "frame", geometryRevision: 1, actionId, frame: 0 });
    assert.notEqual(h.actor.getSnapshot().context.loopFrame?.frame, 0);
    const before = h.actor.getSnapshot();
    h.menus[0].closePopup();
    assert.equal(h.actor.getSnapshot(), before);
    assert.equal(h.timeline.pausedAt, undefined);
  });
}

// The platform can show the window natively while a reload is under way; until
// the next poll hides it again, the pet is shown without a ready renderer.
test("a shown pet whose renderer is not ready takes no input and no hit", (t) => {
  const h = harness(t, false);
  h.frame(0);
  void h.presence.load();
  h.lifecycle.show();
  assert.equal(h.presence.shown, true);
  h.interaction.startPolling();
  assert.equal(h.pet.ignoring, true);
  // A paint report from a renderer that is not ready is dropped.
  h.frame(2);
  assert.equal(h.interaction.displayed?.frame, 0);
  const gesture = {
    geometryRevision: h.environment.geometryRevision,
    gestureId: 7,
  };
  h.input({
    ...gesture,
    type: "press",
    actionId: h.actor.getSnapshot().context.actionId,
    x: 120,
    y: 120,
    screenX: 520,
    screenY: 680,
  });
  h.input({ ...gesture, type: "move", screenX: 620, screenY: 680 });
  assert.equal(h.interaction.gestureActive, false);
  assert.equal(h.actor.getSnapshot().value, "resting");
});

// Quitting keeps the pet shown while Dock capture drains; until the window
// closes, it still answers the pointer exactly as before the quit began.
test("a quitting pet still takes a drag while it stays shown", (t) => {
  const h = harness(t, false);
  h.presence.beginShutdown();
  assert.equal(h.presence.observable, false);
  h.frame(0);
  const gesture = {
    geometryRevision: h.environment.geometryRevision,
    gestureId: 7,
  };
  h.input({
    ...gesture,
    type: "press",
    actionId: h.actor.getSnapshot().context.actionId,
    x: 120,
    y: 120,
    screenX: 520,
    screenY: 680,
  });
  h.input({ ...gesture, type: "move", screenX: 620, screenY: 680 });
  assert.equal(h.actor.getSnapshot().value, "dragging");
});

// Cancelling a shown pet that is quitting still cancels rather than pauses.
test("cancelling a quitting pet that stays shown does not pause it", (t) => {
  const h = harness(t, false);
  h.presence.beginShutdown();
  h.interaction.cancel();
  assert.equal(h.actor.getSnapshot().value, "resting");
});

test("an old menu callback cannot close a newer menu or replay a handoff", (t) => {
  const h = harness(t);
  h.openAtBoundary();
  h.menus[0].closePopup();
  h.input({
    type: "context",
    geometryRevision: 1,
    actionId: h.actor.getSnapshot().context.actionId,
    x: 120,
    y: 120,
  });
  h.actor.send({ type: "PLAY", action: "looking" });
  h.frame(0);
  const id = h.actor.getSnapshot().context.actionId;
  h.menus[0].closePopup();
  assert.equal(h.interaction.menuOpen, true);
  assert.equal(h.timeline.pausedAt, undefined);
  assert.equal(h.actor.getSnapshot().value, "looking");
  h.menus[1].closePopup();
  assert.equal(h.actor.getSnapshot().context.actionId, id);
});

test("Corgi updates its painted hit region during native menus", (t) => {
  const h = harness(t, false);
  h.openAtBoundary();
  h.frame(0);
  assert.equal(h.interaction.displayed?.frame, 0);
  assert.equal(h.actor.getSnapshot().context.loopFrame, undefined);
  h.menus[0].closePopup();
  assert.equal(h.actor.getSnapshot().value, "resting");
  assert.equal(h.timeline.pausedAt, undefined);
});

test("a drag keeps the whole window inside the work area", (t) => {
  const h = harness(t, false);
  h.frame(0);
  const gesture = {
    geometryRevision: h.environment.geometryRevision,
    gestureId: 7,
  };
  h.input({
    ...gesture,
    type: "press",
    actionId: h.actor.getSnapshot().context.actionId,
    x: 120,
    y: 120,
    screenX: 520,
    screenY: 680,
  });
  h.input({ ...gesture, type: "move", screenX: 5520, screenY: -1000 });
  assert.equal(h.actor.getSnapshot().value, "dragging");
  const { x, y } = h.window.windowBounds();
  assert.deepEqual({ x, y }, { x: 760, y: 0 });
});

test("cancelling puts the feet back on the observed Dock edge", (t) => {
  const h = harness(t, false);
  h.frame(0);
  h.footing.observe(
    {
      orientation: "bottom",
      contour: [400, 500, 600].map((axis) => ({ axis, inward: 700 })),
    },
    false,
  );
  h.window.setWindow({ x: 400, y: 100, width: 240, height: 240 });
  h.interaction.cancel();
  const { x, y } = h.window.windowBounds();
  assert.deepEqual({ x, y }, { x: 400, y: 460 });
});
