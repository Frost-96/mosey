import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import {
  closeOwnedElectron,
  ownedProcessGroup,
} from "../tests/support/owned-electron.ts";

const launch = () =>
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
const stop = async (child: ChildProcess) => {
  await closeOwnedElectron({ close: async () => {} }, child, { graceMs: 25 });
};
const live = (child: ChildProcess) =>
  ownedProcessGroup(child.pid!).filter(
    (line) => !line.trim().split(/\s+/)[4]!.startsWith("Z"),
  );

test(
  "a stalled driver close cannot hide the original startup error or kill another session",
  { timeout: 10000 },
  async (t) => {
    const owned = launch();
    const other = launch();
    t.after(() => Promise.all([stop(owned), stop(other)]));
    await Promise.all([once(owned, "spawn"), once(other, "spawn")]);
    const original = new Error("first window deadline");
    const started = performance.now();
    await assert.rejects(
      async () => {
        try {
          throw original;
        } finally {
          const result = await closeOwnedElectron(
            { close: () => new Promise<void>(() => {}) },
            owned,
            { graceMs: 40 },
          );
          assert.equal(result.forced, true);
        }
      },
      (error) => error === original,
    );
    assert.ok(performance.now() - started < 5000);
    assert.deepEqual(live(owned), []);
    assert.notDeepEqual(live(other), []);
  },
);

test(
  "a rejected close still reaps its owned process and preserves the close error",
  { timeout: 10000 },
  async (t) => {
    const owned = launch();
    t.after(() => stop(owned));
    await once(owned, "spawn");
    const original = new Error("driver close rejected");
    await assert.rejects(
      closeOwnedElectron(
        {
          close: async () => {
            throw original;
          },
        },
        owned,
      ),
      (error) => error === original,
    );
    assert.deepEqual(live(owned), []);
  },
);

test(
  "closing the leader also reaps a surviving helper in its owned group",
  { timeout: 10000 },
  async (t) => {
    const owned = spawn(
      process.execPath,
      [
        "-e",
        `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log('ready');
    setInterval(() => {}, 1000);
  `,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    t.after(() => stop(owned));
    await once(owned.stdout!, "data");
    const result = await closeOwnedElectron(
      {
        close: async () => {
          const exit = once(owned, "exit");
          owned.kill("SIGTERM");
          await exit;
        },
      },
      owned,
    );
    assert.equal(result.forced, true);
    assert.deepEqual(live(owned), []);
  },
);
