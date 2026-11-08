import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import type { BrowserWindow } from "electron";
import ts from "typescript";
import { createActor } from "xstate";
import { petBehavior } from "../src/behavior/pet-machine.ts";
import { Timeline } from "../src/behavior/timeline.ts";
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

class PetWindow extends EventEmitter {
  destroyed = false;
  webContents = { mainFrame: {}, send() {} };
  isDestroyed = () => this.destroyed;
  setIgnoreMouseEvents() {}
  getBounds = () => ({ x: 0, y: 0, width: 240, height: 240 });
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
  const pet = new PetWindow();
  const environment = {
    ready: true,
    visibility: "visible",
    suspended: false,
    geometryRevision: 1,
    size: 240,
    character: {
      id: daily ? "gpt" : "corgi",
      resourceVersion: "version-a",
      loopTimings,
      atlases: [{ action: "resting", frames: [{}, {}, {}, {}] }],
      geometry: { frame: () => ({ contains: () => true }) },
    },
    stopMotion() {},
    constrain() {},
    alignGround() {},
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
    environment as unknown as Parameters<typeof createPetInteraction>[3],
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
    if (invalidation === "not-ready") h.environment.ready = false;
    if (invalidation === "hidden") h.environment.visibility = "hidden";
    if (invalidation === "suspended") h.environment.suspended = true;
    if (invalidation === "action") h.actor.send({ type: "CANCEL" });
    h.input({ type: "frame", geometryRevision: 1, actionId, frame: 0 });
    assert.notEqual(h.actor.getSnapshot().context.loopFrame?.frame, 0);
    const before = h.actor.getSnapshot();
    h.menus[0].closePopup();
    assert.equal(h.actor.getSnapshot(), before);
    assert.equal(h.timeline.pausedAt, undefined);
  });
}

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
