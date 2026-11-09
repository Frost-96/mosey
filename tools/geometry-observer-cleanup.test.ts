import assert from "node:assert/strict";
import { test } from "node:test";
import { finishGeometryObservation } from "../tests/support/geometry-observer-cleanup.ts";

for (const stalled of ["records", "stop", "dispose"] as const) {
  test(
    `a stalled geometry ${stalled} cannot block owned session cleanup`,
    { timeout: 1000 },
    async () => {
      const calls: string[] = [];
      const operation = (stage: string) => async () => {
        calls.push(stage);
        if (stage === stalled) return new Promise<never>(() => {});
        return [];
      };
      const evidence = await finishGeometryObservation(
        {
          records: operation("records"),
          stop: operation("stop"),
          dispose: operation("dispose"),
        },
        20,
      );
      calls.push("owned-session-cleanup");
      assert.deepEqual(calls, [
        "records",
        "stop",
        "dispose",
        "owned-session-cleanup",
      ]);
      assert.ok(
        evidence.unavailable.some((reason) => reason.startsWith(`${stalled}:`)),
      );
    },
  );
}

test("geometry cleanup retains records and continues after a disconnected handle", async () => {
  let disposed = false;
  const evidence = await finishGeometryObservation(
    {
      records: async () => [{ input: "press" }],
      stop: async () => {
        throw new Error("Target closed");
      },
      dispose: async () => {
        disposed = true;
      },
    },
    20,
  );
  assert.deepEqual(evidence.records, [{ input: "press" }]);
  assert.deepEqual(evidence.unavailable, ["stop: Error: Target closed"]);
  assert.equal(disposed, true);
});
