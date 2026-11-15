import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import {
  createMemoryPresenceAdapter,
  createPresence,
} from "../src/main/pet/presence.ts";

// Presence is verified only through its interface, with the in-memory adapter
// standing in for the native window.
function fixture() {
  const adapter = createMemoryPresenceAdapter();
  const presence = createPresence(adapter);
  // The platform shows or hides the window, then presence reconciles.
  const show = () => {
    adapter.setVisible(true);
    return presence.synchronize();
  };
  const hide = () => {
    adapter.setVisible(false);
    return presence.synchronize();
  };
  return { adapter, presence, show, hide };
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
  const { presence, show, hide } = fixture();
  presence.rendererLoaded();
  show();
  presence.suspend();
  assert.deepEqual(queries(presence), { observable: false, shown: false });
  presence.resume();
  assert.deepEqual(queries(presence), { observable: true, shown: true });
  // Suspended while hidden, then shown, then resumed.
  hide();
  presence.suspend();
  show();
  assert.deepEqual(queries(presence), { observable: false, shown: false });
  presence.resume();
  assert.deepEqual(queries(presence), { observable: true, shown: true });
});

test("quitting ends observation but keeps the pet shown through the drain", () => {
  const { presence, show } = fixture();
  presence.rendererLoaded();
  show();
  presence.beginShutdown();
  assert.deepEqual(queries(presence), { observable: false, shown: true });
  presence.suspend();
  presence.resume();
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
  const { presence, show } = fixture();
  show();
  presence.suspend();
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
