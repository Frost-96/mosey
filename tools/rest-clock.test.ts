import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { installRestClock } from "../tests/support/rest-clock.ts";

test("rest acceleration preserves preparation, native and animation deadlines", () => {
  const scheduled: { callback: () => void; delay: number; args: unknown[] }[] =
    [];
  const nativeTimeout = (
    callback: () => void,
    delay: number,
    ...args: unknown[]
  ) => {
    scheduled.push({ callback, delay, args });
    return scheduled.length;
  };
  const context = {
    setTimeout: nativeTimeout,
    options: { milliseconds: 800, minimum: 18000, maximum: 34400 },
  };
  const control = runInNewContext(
    `(${installRestClock.toString()})(undefined, options)`,
    context,
  );
  const events: string[] = [];
  const schedule = (name: string, delay: number) =>
    context.setTimeout(() => events.push(name), delay, name);
  schedule("animation", 140);
  schedule("native startup", 10000);
  schedule("character preparation", 15000);
  schedule("rest", 30600);
  schedule("aligned rest", 34000);
  schedule("unrelated long deadline", 60000);
  assert.deepEqual(
    scheduled.map(({ delay }) => delay),
    [140, 10000, 15000, 800, 800, 60000],
  );
  for (const timer of scheduled.filter(({ delay }) => delay <= 1000))
    timer.callback();
  assert.deepEqual(events, ["animation", "rest", "aligned rest"]);
  assert.equal(scheduled[2]!.args[0], "character preparation");
  control.milliseconds = 600;
  schedule("next rest", 19400);
  assert.equal(scheduled.at(-1)!.delay, 600);
  control.restore();
  assert.equal(context.setTimeout, nativeTimeout);
  schedule("rest after restore", 19400);
  assert.equal(scheduled.at(-1)!.delay, 19400);
});
