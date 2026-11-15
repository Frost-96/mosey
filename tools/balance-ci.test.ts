import assert from "node:assert/strict";
import { test } from "node:test";
import { balance } from "./balance-ci.ts";

test("every mode/scale/file is assigned exactly once, including unknown files", () => {
  const items = [
    "development-1x",
    "development-2x",
    "packaged-1x",
    "packaged-2x",
  ].flatMap((project) =>
    ["slow", "medium", "fast", "new"].map((file) => ({ project, file })),
  );
  const durations: Record<string, number> = { slow: 200, medium: 90, fast: 10 };
  const seconds = (item: (typeof items)[number]) => durations[item.file] ?? 60;
  const identity = (item: (typeof items)[number]) =>
    `${item.project}/${item.file}`;
  const shards = balance(items, 5, seconds, identity);
  assert.deepEqual(
    shards.flat().map(identity).sort(),
    items.map(identity).sort(),
  );
  assert.deepEqual(balance([...items].reverse(), 5, seconds, identity), shards);
  assert.equal(new Set(shards.flat().map(identity)).size, items.length);
  assert(shards.every((shard) => shard.length > 0));
  const totals = shards.map((shard) =>
    shard.reduce((sum, item) => sum + seconds(item), 0),
  );
  assert(Math.max(...totals) - Math.min(...totals) <= 90);
});

test("reserved seconds move work away from a shard with other duties", () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  const seconds = () => 10;
  const identity = (item: string) => item;
  const shards = balance(items, 3, seconds, identity, [25]);
  assert.deepEqual(shards.flat().sort(), [...items].sort());
  assert.equal(shards[0]!.length, 0);
  assert.deepEqual(
    shards.map((shard) => shard.length),
    [0, 3, 3],
  );
});
