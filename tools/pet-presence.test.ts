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
// standing in for the native window and the system events it reports.
function fixture() {
  const adapter = createMemoryPresenceAdapter();
  const transitions: PresenceTransition["type"][] = [];
  const presence = createPresence(adapter, (transition) =>
    transitions.push(transition.type),
  );
  // The platform shows or hides the window, then presence reconciles.
  const show = () => {
    adapter.setVisible(true);
    return presence.synchronize();
  };
  const hide = () => {
    adapter.setVisible(false);
    return presence.synchronize();
  };
  // A ready renderer in a shown window: the pet is being observed.
  const observe = () => {
    presence.rendererLoaded();
    show();
    transitions.length = 0;
  };
  return { adapter, presence, show, hide, observe, transitions };
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
  presence.rendererLoading();
  assert.deepEqual(queries(presence), { observable: false, shown: true });
  presence.rendererLoaded();
  presence.rendererFailed();
  assert.deepEqual(queries(presence), { observable: false, shown: true });
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

test("repeated native notifications report each visibility edge once", () => {
  const { presence, show, hide } = fixture();
  assert.equal(presence.synchronize(), undefined);
  assert.equal(show(), "visible");
  assert.equal(show(), undefined);
  assert.equal(presence.synchronize(), undefined);
  assert.equal(hide(), "hidden");
  assert.equal(hide(), undefined);
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
  presence.rendererLoaded();
  adapter.show();
  adapter.show();
  presence.synchronize();
  assert.deepEqual(transitions, ["observed"]);
  adapter.hide();
  adapter.hide();
  presence.synchronize();
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
