import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  launchForgeServer,
  nativeRuntimeIdentity,
  verifyNativeRuntime,
} from "./forge-server.ts";

test("shared preparation rejects a native producer left behind by a fixture", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-native-baseline-"));
  const previous = process.cwd();
  t.after(async () => {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  });
  process.chdir(root);
  await mkdir("build/native", { recursive: true });
  const file = "build/native/dock-runtime";
  await writeFile(file, "original runtime", { mode: 0o755 });
  const baseline = await nativeRuntimeIdentity();
  await verifyNativeRuntime(baseline);
  await writeFile(file, "substituted producer");
  await assert.rejects(verifyNativeRuntime(baseline), /did not restore/);
  await writeFile(file, "original runtime");
  await chmod(file, 0o644);
  await assert.rejects(verifyNativeRuntime(baseline), /did not restore/);
  await rm(file);
  await assert.rejects(verifyNativeRuntime(baseline), { code: "ENOENT" });
});

test("the run owns one live server until teardown, without stopping another owner", async (t) => {
  const options = {
    command: process.execPath,
    args: [
      "-e",
      'console.log("MOSEY_TEST_READY"); setInterval(() => {}, 1000)',
    ],
  };
  const first = await launchForgeServer(options);
  t.after(first.stop);
  const second = await launchForgeServer(options);
  t.after(second.stop);
  first.assertRunning();
  second.assertRunning();
  await Promise.all([first.stop(), first.stop()]);
  assert.throws(first.assertRunning, /server exited/);
  second.assertRunning();
  assert.throws(() => process.kill(first.pid, 0), { code: "ESRCH" });
});

test("startup failure reports the original server output", async () => {
  await assert.rejects(
    launchForgeServer({
      command: process.execPath,
      args: ["-e", 'console.error("fixture startup failure"); process.exit(2)'],
    }),
    /fixture startup failure/,
  );
});

test("a stalled startup is bounded and cleans up its owned process", async () => {
  await assert.rejects(
    launchForgeServer({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 100,
    }),
    /startup exceeded 100ms/,
  );
});

test("a server that dies after readiness is reported instead of reused", async (t) => {
  const server = await launchForgeServer({
    command: process.execPath,
    args: [
      "-e",
      'console.log("MOSEY_TEST_READY"); setInterval(() => {}, 1000)',
    ],
  });
  t.after(server.stop);
  process.kill(server.pid, "SIGTERM");
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      server.assertRunning();
    } catch {
      return;
    }
    await delay(10);
  }
  assert.fail("The crashed shared server was still considered usable");
});
