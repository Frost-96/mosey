import assert from "node:assert/strict";
import { executionAsyncResource } from "node:async_hooks";
import { test } from "node:test";
import type { ElectronApplication } from "playwright";
import { onMainLoop } from "../tests/support/main-loop.ts";

// Stands in for Playwright's Electron handle: inspector evaluation runs the
// function at once, inside whatever the main thread was dispatching.
const electron = { name: "electron stand-in" };
const app = {
  evaluate: (fn: (electron: unknown, arg: unknown) => unknown, arg: unknown) =>
    Promise.resolve(fn(electron, arg)),
} as unknown as Pick<ElectronApplication, "evaluate">;

test("input dispatched during a timer's dispatch runs outside that timer", async () => {
  const ran = await new Promise((resolve, reject) =>
    setTimeout(() => {
      Reflect.set(globalThis, "dispatchingTimer", executionAsyncResource());
      // Evaluated input carries no closure, as in the main process.
      onMainLoop(
        app,
        () =>
          (
            process.getBuiltinModule(
              "node:async_hooks",
            ) as typeof import("node:async_hooks")
          ).executionAsyncResource() ===
          Reflect.get(globalThis, "dispatchingTimer"),
      ).then(resolve, reject);
    }),
  );
  assert.equal(ran, false);
});

test("dispatched input receives the electron module and its argument", async () => {
  const result = await onMainLoop(
    app,
    (electron, item: { label: string }) =>
      `${(electron as unknown as { name: string }).name} clicked ${item.label}`,
    { label: "Hide Mosey" },
  );
  assert.equal(result, "electron stand-in clicked Hide Mosey");
});
