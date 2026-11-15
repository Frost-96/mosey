import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import {
  createMemoryPresenceAdapter,
  createPresence,
  type PresenceTransition,
} from "../src/main/pet/presence.ts";

// Presence is verified only through its interface, with the in-memory adapter
// standing in for the native window, the stored intent and the system events.
// The log records, in order, each show preparation, each show or hide presence
// asks of the window, and each transition it reports.
function fixture() {
  const adapter = createMemoryPresenceAdapter();
  const log: string[] = [];
  const transitions: PresenceTransition["type"][] = [];
  const presence = createPresence(
    {
      ...adapter,
      show() {
        log.push("show");
        adapter.show();
      },
      hide() {
        log.push("hide");
        adapter.hide();
      },
    },
    (transition) => {
      log.push(transition.type);
      transitions.push(transition.type);
    },
    () => log.push("prepare"),
  );
  // The platform shows or hides the window and reports it.
  const show = () => adapter.show();
  const hide = () => adapter.hide();
  // A ready renderer in a shown window: the pet is being observed.
  const observe = () => {
    adapter.finishLoad();
    show();
    transitions.length = 0;
    log.length = 0;
  };
  return { adapter, presence, show, hide, observe, transitions, log };
}

const queries = (presence: ReturnType<typeof fixture>["presence"]) => ({
  observable: presence.observable,
  shown: presence.shown,
});

test("presence never imports Electron, directly or through its imports", () => {
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
  visit(new URL("../src/main/pet/presence.ts", import.meta.url));
});

test("a pet that has never loaded or been shown is neither observable nor shown", () => {
  const { presence } = fixture();
  assert.deepEqual(queries(presence), { observable: false, shown: false });
});

test("a shown window is observable only once its renderer is ready", () => {
  const { adapter, presence, show } = fixture();
  show();
  assert.deepEqual(queries(presence), { observable: false, shown: true });
  adapter.finishLoad();
  assert.deepEqual(queries(presence), { observable: true, shown: true });
  // A renderer that is not ready never stays shown.
  void presence.load();
  assert.deepEqual(queries(presence), { observable: false, shown: false });
  adapter.finishLoad();
  // The automatic recovery, then a failed renderer.
  adapter.exitRenderer();
  adapter.finishLoad();
  adapter.exitRenderer();
  assert.equal(presence.failed, true);
  assert.deepEqual(queries(presence), { observable: false, shown: false });
});

test("suspension hides a shown pet from both queries until it resumes", () => {
  const { adapter, presence, show, hide } = fixture();
  adapter.finishLoad();
  show();
  adapter.suspend();
  assert.deepEqual(queries(presence), { observable: false, shown: false });
  adapter.resume();
  assert.deepEqual(queries(presence), { observable: true, shown: true });
  // Suspended while hidden, then shown, then resumed.
  hide();
  adapter.suspend();
  show();
  assert.deepEqual(queries(presence), { observable: false, shown: false });
  adapter.resume();
  assert.deepEqual(queries(presence), { observable: true, shown: true });
});

test("quitting ends observation but keeps the pet shown through the drain", () => {
  const { adapter, presence, show } = fixture();
  adapter.finishLoad();
  show();
  presence.beginShutdown();
  assert.deepEqual(queries(presence), { observable: false, shown: true });
  adapter.suspend();
  adapter.resume();
  adapter.finishLoad();
  assert.deepEqual(queries(presence), { observable: false, shown: true });
});

test("reconciling reports each silent visibility change once", () => {
  const { adapter, presence, observe } = fixture();
  observe();
  assert.equal(presence.reconcile(), undefined);
  adapter.setVisible(false);
  assert.equal(presence.reconcile(), "hidden");
  assert.equal(presence.reconcile(), undefined);
  adapter.setVisible(true);
  assert.equal(presence.reconcile(), "visible");
  assert.equal(presence.reconcile(), undefined);
});

// The character switch reads suspension on its own: a hidden pet may still
// switch character, a sleeping one may not.
test("suspension stays readable apart from visibility", () => {
  const { adapter, presence, observe, hide } = fixture();
  observe();
  adapter.suspend();
  hide();
  assert.equal(presence.suspended, true);
  adapter.resume();
  assert.equal(presence.suspended, false);
});

test("suspending an observed pet stops observation once, and waking starts it once", () => {
  const { adapter, observe, transitions } = fixture();
  observe();
  adapter.suspend();
  // Sleep and a locked screen both report suspension.
  adapter.suspend();
  assert.deepEqual(transitions, ["unobserved"]);
  adapter.resume();
  adapter.resume();
  assert.deepEqual(transitions, ["unobserved", "observed"]);
});

test("a pet suspended while hidden starts observation only after it is shown and wakes", () => {
  const { adapter, presence, show, hide, observe, transitions } = fixture();
  observe();
  hide();
  adapter.suspend();
  show();
  assert.deepEqual(transitions, ["unobserved"]);
  adapter.resume();
  assert.deepEqual(transitions, ["unobserved", "observed"]);
  assert.equal(presence.observable, true);
});

test("duplicate or coalesced native visibility notifications never repeat a transition", () => {
  const { adapter, presence, observe, transitions } = fixture();
  adapter.show();
  adapter.finishLoad();
  adapter.show();
  presence.reconcile();
  assert.deepEqual(transitions, ["rendererReady", "observed"]);
  adapter.hide();
  adapter.hide();
  presence.reconcile();
  assert.deepEqual(transitions, ["rendererReady", "observed", "unobserved"]);
  // A hide and show the platform coalesced into no observable change.
  observe();
  adapter.setVisible(false);
  adapter.setVisible(true);
  adapter.show();
  assert.deepEqual(transitions, []);
});

test("a window shown before its renderer is ready starts observation when the renderer loads", () => {
  const { adapter, show, transitions } = fixture();
  show();
  assert.deepEqual(transitions, []);
  adapter.finishLoad();
  assert.deepEqual(transitions, ["rendererReady", "observed"]);
});

// Quitting is the one exception: it ends observability without a stop, so the
// pet keeps moving through the Dock capture drain; it only blocks a new start.
test("beginning to quit never stops observation", () => {
  const { presence, observe, transitions } = fixture();
  observe();
  presence.beginShutdown();
  assert.equal(presence.observable, false);
  assert.deepEqual(transitions, []);
});

test("waking while quitting never starts observation", () => {
  const { adapter, presence, observe, transitions } = fixture();
  observe();
  adapter.suspend();
  presence.beginShutdown();
  adapter.resume();
  assert.deepEqual(transitions, ["unobserved"]);
});

test("a pet still observed while quitting stops observation when it is suspended or hidden", () => {
  for (const end of ["suspend", "hide"] as const) {
    const { adapter, presence, observe, transitions } = fixture();
    observe();
    presence.beginShutdown();
    adapter[end]();
    assert.deepEqual(transitions, ["unobserved"], end);
  }
});

// Presence alone shows and hides the window; the stored intent is only read.
test("the poll hides a window the platform showed before its renderer was ready", () => {
  const { adapter, presence, log } = fixture();
  adapter.setVisible(true);
  assert.equal(presence.reconcile(), undefined);
  assert.equal(adapter.nativelyVisible(), false);
  assert.deepEqual(log, ["hide"]);
  assert.equal(adapter.intent(), "visible");
});

test("a renderer reload hides the pet without changing its intent and shows it again once loaded", () => {
  const { adapter, presence, observe, log } = fixture();
  observe();
  void presence.load();
  assert.deepEqual(log, ["hide", "unobserved", "rendererRetired"]);
  assert.equal(adapter.intent(), "visible");
  adapter.finishLoad();
  assert.deepEqual(log, [
    "hide",
    "unobserved",
    "rendererRetired",
    "rendererReady",
    "prepare",
    "show",
    "observed",
  ]);
});

test("a hidden intent hides the pet and keeps it hidden through reloads and silent shows", () => {
  const { adapter, presence, observe, log } = fixture();
  observe();
  adapter.setIntent("hidden");
  assert.equal(presence.intentChanged(), "hidden");
  void presence.load();
  adapter.finishLoad();
  adapter.setVisible(true);
  presence.reconcile();
  assert.deepEqual(log, [
    "hide",
    "unobserved",
    "rendererRetired",
    "rendererReady",
    "hide",
  ]);
  assert.equal(adapter.nativelyVisible(), false);
  assert.equal(adapter.intent(), "hidden");
});

test("choosing to show prepares the pet before showing it, only once its renderer is ready", () => {
  const { adapter, presence, log } = fixture();
  adapter.setIntent("hidden");
  adapter.finishLoad();
  adapter.setIntent("visible");
  assert.equal(presence.intentChanged(), "visible");
  assert.deepEqual(log, ["rendererReady", "prepare", "show", "observed"]);
  void presence.load();
  log.length = 0;
  presence.intentChanged();
  assert.deepEqual(log, []);
  assert.equal(adapter.nativelyVisible(), false);
});

// Preparation readies a pet about to be observed. A suspended pet is shown,
// as before, but stays paused until it wakes.
test("a pet shown while suspended is not prepared and starts observation when it wakes", () => {
  const { adapter, log } = fixture();
  adapter.suspend();
  adapter.finishLoad();
  assert.deepEqual(log, ["rendererReady", "show"]);
  adapter.resume();
  assert.deepEqual(log, ["rendererReady", "show", "observed"]);
});

// Presence decides the renderer lifecycle; the adapter only performs loads and
// reports page loads and renderer exits.
test("the first renderer exit reloads once, retiring a hidden pet, and shows it again once loaded", () => {
  const { adapter, presence, observe, log } = fixture();
  observe();
  adapter.exitRenderer();
  // The stop meets a hidden pet; retirement follows it.
  assert.deepEqual(log, ["hide", "unobserved", "rendererRetired"]);
  assert.equal(adapter.loads.length, 1);
  assert.equal(adapter.intent(), "visible");
  adapter.finishLoad();
  assert.deepEqual(log.slice(3), [
    "rendererReady",
    "prepare",
    "show",
    "observed",
  ]);
  assert.equal(presence.failed, false);
});

// Load settlement crosses a promise; let it run before asserting.
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a second renderer exit fails the renderer without loading again", () => {
  const { adapter, presence, observe, log } = fixture();
  observe();
  adapter.exitRenderer();
  adapter.finishLoad();
  log.length = 0;
  adapter.exitRenderer();
  assert.deepEqual(log, [
    "hide",
    "unobserved",
    "rendererRetired",
    "rendererFailed",
  ]);
  assert.equal(adapter.loads.length, 1);
  assert.equal(presence.failed, true);
  assert.equal(adapter.nativelyVisible(), false);
});

test("a failed automatic reload fails the renderer and keeps the pet hidden", async () => {
  const { adapter, presence, observe, log } = fixture();
  observe();
  adapter.exitRenderer();
  adapter.loads[0].reject(new Error("load failed"));
  await settled();
  assert.equal(presence.failed, true);
  assert.deepEqual(log, [
    "hide",
    "unobserved",
    "rendererRetired",
    "rendererRetired",
    "rendererFailed",
  ]);
  // A failed renderer is never shown, even when the window reports a show.
  adapter.setVisible(true);
  presence.reconcile();
  assert.equal(adapter.nativelyVisible(), false);
});

test("a failure carries the load error so the caller can report it", async () => {
  const adapter = createMemoryPresenceAdapter();
  const failures: PresenceTransition[] = [];
  const presence = createPresence(
    adapter,
    (transition) => {
      if (transition.type === "rendererFailed") failures.push(transition);
    },
    () => {},
  );
  const error = new Error("load failed");
  const loading = presence.load();
  adapter.loads[0].reject(error);
  await loading;
  // A repeated exit has no load error to carry.
  void presence.load();
  adapter.finishLoad();
  adapter.exitRenderer();
  adapter.finishLoad();
  adapter.exitRenderer();
  assert.deepEqual(failures, [
    { type: "rendererFailed", error },
    { type: "rendererFailed" },
  ]);
});

test("a stale load's failure is dropped once a newer load has started", async () => {
  const { adapter, presence } = fixture();
  const first = presence.load();
  const second = presence.load();
  adapter.loads[0].reject(new Error("superseded"));
  await first;
  assert.equal(presence.failed, false);
  adapter.loads[1].reject(new Error("latest failed"));
  await second;
  assert.equal(presence.failed, true);
});

test("a manual retry loads again but never restores the automatic recovery", () => {
  const { adapter, presence, observe, transitions } = fixture();
  observe();
  adapter.exitRenderer();
  adapter.finishLoad();
  adapter.exitRenderer();
  assert.equal(presence.failed, true);
  void presence.load();
  assert.equal(presence.failed, false);
  assert.equal(adapter.loads.length, 2);
  adapter.finishLoad();
  assert.equal(presence.observable, true);
  transitions.length = 0;
  adapter.exitRenderer();
  assert.equal(adapter.loads.length, 2);
  assert.equal(presence.failed, true);
  assert.deepEqual(transitions, [
    "unobserved",
    "rendererRetired",
    "rendererFailed",
  ]);
});

test("a page load only readies a loading renderer", () => {
  const { adapter, presence, observe, transitions } = fixture();
  observe();
  // A reload of an already ready page, such as a development reload.
  adapter.finishLoad();
  assert.deepEqual(transitions, []);
  adapter.exitRenderer();
  adapter.finishLoad();
  adapter.exitRenderer();
  transitions.length = 0;
  adapter.finishLoad();
  assert.deepEqual(transitions, []);
  assert.equal(presence.failed, true);
});

test("quitting ends the renderer lifecycle: no load, exit or load result is acted on", async () => {
  const { adapter, presence, observe, transitions } = fixture();
  observe();
  // The automatic recovery is spent, so an exit would otherwise fail.
  adapter.exitRenderer();
  adapter.finishLoad();
  const loading = presence.load();
  adapter.finishLoad();
  transitions.length = 0;
  presence.beginShutdown();
  await presence.load();
  adapter.exitRenderer();
  adapter.finishLoad();
  adapter.loads[1].reject(new Error("aborted by quit"));
  await loading;
  assert.equal(adapter.loads.length, 2);
  assert.deepEqual(transitions, []);
  assert.equal(presence.failed, false);
});
