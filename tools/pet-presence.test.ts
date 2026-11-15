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
    presence.rendererLoaded();
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
  const { presence, show } = fixture();
  show();
  assert.deepEqual(queries(presence), { observable: false, shown: true });
  presence.rendererLoaded();
  assert.deepEqual(queries(presence), { observable: true, shown: true });
  // A renderer that is not ready never stays shown.
  presence.rendererLoading();
  assert.deepEqual(queries(presence), { observable: false, shown: false });
  presence.rendererLoaded();
  presence.rendererFailed();
  assert.deepEqual(queries(presence), { observable: false, shown: false });
});

test("suspension hides a shown pet from both queries until it resumes", () => {
  const { adapter, presence, show, hide } = fixture();
  presence.rendererLoaded();
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
  presence.rendererLoaded();
  show();
  presence.beginShutdown();
  assert.deepEqual(queries(presence), { observable: false, shown: true });
  adapter.suspend();
  adapter.resume();
  presence.rendererLoaded();
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

// Callers the queries cannot serve yet read the lifecycle dimensions directly.
test("each lifecycle dimension stays readable on its own", () => {
  const { adapter, presence, show } = fixture();
  show();
  adapter.suspend();
  assert.deepEqual(
    {
      visibility: presence.visibility,
      suspended: presence.suspended,
      quitting: presence.quitting,
    },
    { visibility: "visible", suspended: true, quitting: false },
  );
  presence.beginShutdown();
  assert.equal(presence.quitting, true);
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
  presence.rendererLoaded();
  adapter.show();
  presence.reconcile();
  assert.deepEqual(transitions, ["observed"]);
  adapter.hide();
  adapter.hide();
  presence.reconcile();
  assert.deepEqual(transitions, ["observed", "unobserved"]);
  // A hide and show the platform coalesced into no observable change.
  observe();
  adapter.setVisible(false);
  adapter.setVisible(true);
  adapter.show();
  assert.deepEqual(transitions, []);
});

test("a window shown before its renderer is ready starts observation when the renderer loads", () => {
  const { presence, show, transitions } = fixture();
  show();
  assert.deepEqual(transitions, []);
  presence.rendererLoaded();
  assert.deepEqual(transitions, ["observed"]);
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
  presence.rendererLoading();
  assert.deepEqual(log, ["hide", "unobserved"]);
  assert.equal(adapter.intent(), "visible");
  presence.rendererLoaded();
  assert.deepEqual(log, ["hide", "unobserved", "prepare", "show", "observed"]);
});

test("a hidden intent hides the pet and keeps it hidden through reloads and silent shows", () => {
  const { adapter, presence, observe, log } = fixture();
  observe();
  adapter.setIntent("hidden");
  assert.equal(presence.intentChanged(), "hidden");
  presence.rendererLoading();
  presence.rendererLoaded();
  adapter.setVisible(true);
  presence.reconcile();
  assert.deepEqual(log, ["hide", "unobserved", "hide"]);
  assert.equal(adapter.nativelyVisible(), false);
  assert.equal(adapter.intent(), "hidden");
});

test("choosing to show prepares the pet before showing it, only once its renderer is ready", () => {
  const { adapter, presence, log } = fixture();
  adapter.setIntent("hidden");
  presence.rendererLoaded();
  adapter.setIntent("visible");
  assert.equal(presence.intentChanged(), "visible");
  assert.deepEqual(log, ["prepare", "show", "observed"]);
  presence.rendererLoading();
  log.length = 0;
  presence.intentChanged();
  assert.deepEqual(log, []);
  assert.equal(adapter.nativelyVisible(), false);
});

// Preparation readies a pet about to be observed. A suspended pet is shown,
// as before, but stays paused until it wakes.
test("a pet shown while suspended is not prepared and starts observation when it wakes", () => {
  const { adapter, presence, log } = fixture();
  adapter.suspend();
  presence.rendererLoaded();
  assert.deepEqual(log, ["show"]);
  adapter.resume();
  assert.deepEqual(log, ["show", "observed"]);
});
