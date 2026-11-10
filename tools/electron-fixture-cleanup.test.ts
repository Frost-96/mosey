import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createElectronFixtureCleanup } from "../tests/support/electron-fixture-cleanup.ts";
import { emptyDockCapture } from "../tests/support/empty-dock.ts";
import { closeOwnedElectron } from "../tests/support/owned-electron.ts";

const startChild = () =>
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
const stopChild = (child: ChildProcess) =>
  closeOwnedElectron({ close: async () => {} }, child, { graceMs: 25 });
const application = (child: ChildProcess) => ({
  process: () => child,
  close: async () => {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  },
});

test(
  "a stalled pre-close diagnostic cannot block process cleanup or the next fixture",
  { timeout: 5000 },
  async (t) => {
    const child = startChild();
    t.after(() => stopChild(child));
    await once(child, "spawn");
    const original = new Error("application observation failed");
    let released = false;
    const fixture = createElectronFixtureCleanup(
      [
        () => {
          released = true;
        },
      ],
      () => new Promise<void>(() => {}),
    );
    await fixture.launch(async () => application(child));
    const result = await Promise.race([
      fixture.cleanup({ error: original }).then(
        () => undefined,
        (error: unknown) => error,
      ),
      delay(2000, "cleanup stalled"),
    ]);
    assert.ok(result instanceof AggregateError, String(result));
    assert.equal(result.errors[0], original);
    assert.match(String(result.errors[1].errors[0]), /before-close.*deadline/i);
    assert.equal(released, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    const next = startChild();
    t.after(() => stopChild(next));
    await once(next, "spawn");
    const following = createElectronFixtureCleanup([]);
    await following.launch(async () => application(next));
    await following.cleanup();
    assert.ok(next.exitCode !== null || next.signalCode !== null);
  },
);

test("cleanup attempts every release once and preserves the original failure", async () => {
  const calls: string[] = [];
  const original = new Error("scenario failed");
  const first = new Error("restore failed");
  const second = new Error("Forge stop failed");
  const fixture = createElectronFixtureCleanup([
    () => {
      calls.push("restore");
      throw first;
    },
    () => {
      calls.push("Forge");
      throw second;
    },
    () => {
      calls.push("remove");
    },
  ]);
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(fixture.cleanup({ error: original }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, error.errors[1]);
      assert.equal(error.errors[0], original);
      assert.deepEqual(error.errors[1].errors, [first, second]);
      return true;
    });
  assert.deepEqual(calls, ["restore", "Forge", "remove"]);
});

test(
  "an explicit restart rejects a forced close instead of hiding a shutdown failure",
  { timeout: 10000 },
  async (t) => {
    const child = startChild();
    t.after(() => stopChild(child));
    await once(child, "spawn");
    const fixture = createElectronFixtureCleanup([]);
    await fixture.launch(async () => ({
      process: () => child,
      close: () => new Promise<void>(() => {}),
    }));
    await assert.rejects(fixture.closeApp(), /required forced termination/);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await fixture.cleanup();
  },
);

test(
  "a late launch is killed before restoring native bytes and mode",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mosey-late-launch-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const helper = path.join(root, "dock-runtime");
    await writeFile(helper, "original native bytes");
    await chmod(helper, 0o751);
    const restore = await emptyDockCapture(helper);
    const child = startChild();
    t.after(() => stopChild(child));
    await once(child, "spawn");
    let release!: (value: ReturnType<typeof application>) => void;
    const gate = new Promise<ReturnType<typeof application>>((resolve) => {
      release = resolve;
    });
    let restored = false;
    const fixture = createElectronFixtureCleanup([
      async () => {
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        await restore();
        restored = true;
      },
    ]);
    const launch = fixture.launch(() => gate);
    const rejectedLaunch = assert.rejects(launch, /closed during launch/);
    const cleanup = fixture.cleanup();
    assert.equal(restored, false);
    release({
      ...application(child),
      close: () => new Promise<void>(() => {}),
    });
    await Promise.all([rejectedLaunch, cleanup]);
    assert.equal(await readFile(helper, "utf8"), "original native bytes");
    assert.equal((await stat(helper)).mode & 0o777, 0o751);
    assert.equal(restored, true);
  },
);

test(
  "restart closes each acquired process and a closed fixture cannot relaunch",
  { timeout: 10000 },
  async (t) => {
    const first = startChild();
    const second = startChild();
    t.after(() => Promise.all([stopChild(first), stopChild(second)]));
    await Promise.all([once(first, "spawn"), once(second, "spawn")]);
    const fixture = createElectronFixtureCleanup([]);
    await fixture.launch(async () => application(first));
    await fixture.closeApp();
    assert.ok(first.exitCode !== null || first.signalCode !== null);
    const next = application(second);
    await fixture.launch(async () => next);
    next.process = () => {
      throw new Error("driver accessor detached");
    };
    await Promise.all([fixture.cleanup(), fixture.cleanup()]);
    assert.ok(second.exitCode !== null || second.signalCode !== null);
    let attempted = false;
    await assert.rejects(
      fixture.launch(async () => {
        attempted = true;
        return next;
      }),
      /Cannot launch a closed/,
    );
    assert.equal(attempted, false);
  },
);

test(
  "rejected process close still restores resources and retains both errors",
  { timeout: 10000 },
  async (t) => {
    const child = startChild();
    t.after(() => stopChild(child));
    await once(child, "spawn");
    const original = new Error("first window failed");
    const closeError = new Error("driver close rejected");
    let restored = false;
    const fixture = createElectronFixtureCleanup([
      () => {
        restored = true;
      },
    ]);
    await fixture.launch(async () => ({
      process: () => child,
      close: async () => {
        throw closeError;
      },
    }));
    await assert.rejects(fixture.cleanup({ error: original }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, error.errors[1]);
      assert.equal(error.errors[0], original);
      assert.deepEqual(error.errors[1].errors, [closeError]);
      return true;
    });
    assert.equal(restored, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  },
);

test("startup failure restores its substitution and successful cleanup keeps the original error", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-startup-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = path.join(root, "dock-runtime");
  await writeFile(helper, "native");
  await chmod(helper, 0o750);
  let restore: (() => Promise<void>) | undefined;
  const fixture = createElectronFixtureCleanup([
    async () => {
      await restore?.();
    },
  ]);
  const original = new Error("launch rejected after preparation");
  await assert.rejects(
    fixture.launch(async () => {
      restore = await emptyDockCapture(helper);
      throw original;
    }),
    (error) => error === original,
  );
  await assert.rejects(
    fixture.cleanup({ error: original }),
    (error) => error === original,
  );
  await fixture.cleanup();
  assert.equal(await readFile(helper, "utf8"), "native");
  assert.equal((await stat(helper)).mode & 0o777, 0o750);
});
