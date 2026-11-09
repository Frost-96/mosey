import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { collectNativeCrashEvidence } from "../tests/support/native-crash-evidence.ts";

test("native crash evidence copies only this PID's report after its launch", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "mosey-crash-evidence-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "evidence");
  await mkdir(output);
  const launchedAt = Date.now() - 1000;
  const report = (pid: number, capturedAt: number) =>
    JSON.stringify({ bug_type: "309" }) +
    "\n" +
    JSON.stringify({ pid, captureTime: new Date(capturedAt).toISOString() });
  await writeFile(
    path.join(directory, "Electron-3.ips"),
    report(456, Date.now()),
  );
  await writeFile(
    path.join(directory, "Electron-2.ips"),
    report(123, launchedAt - 1000),
  );
  const expected = report(123, Date.now());
  await writeFile(path.join(directory, "Electron-1.ips"), expected);
  const result = await collectNativeCrashEvidence({
    pid: 123,
    executable: "Electron",
    launchedAt,
    evidenceDirectory: output,
    reportsDirectory: directory,
    timeoutMs: 1000,
  });
  assert.deepEqual(result, { report: "native-crash-123.ips" });
  assert.deepEqual(await readdir(output), ["native-crash-123.ips"]);
  assert.equal(
    await readFile(path.join(output, result.report!), "utf8"),
    expected,
  );
});

test("missing, partial and unrelated reports cannot replace the test failure", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "mosey-crash-evidence-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "evidence");
  await mkdir(output);
  await writeFile(path.join(directory, "Electron-incomplete.ips"), "{");
  await writeFile(
    path.join(directory, "OtherApp-1.ips"),
    JSON.stringify({ pid: 123, captureTime: new Date().toISOString() }),
  );
  const request = {
    pid: 123,
    executable: "Electron",
    launchedAt: Date.now() - 1000,
    evidenceDirectory: output,
    reportsDirectory: directory,
    timeoutMs: 25,
  };
  assert.ok((await collectNativeCrashEvidence(request)).unavailable);
  assert.deepEqual(await readdir(output), []);
  assert.ok(
    (
      await collectNativeCrashEvidence({
        ...request,
        reportsDirectory: path.join(directory, "missing"),
      })
    ).unavailable,
  );
});

test("a native report completed after process exit is collected within the deadline", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "mosey-crash-evidence-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "evidence");
  await mkdir(output);
  const file = path.join(directory, "Mosey-1.ips");
  await writeFile(file, "{");
  const completing = delay(40).then(() =>
    writeFile(
      file,
      JSON.stringify({
        pid: 123,
        captureTime: new Date()
          .toISOString()
          .replace("T", " ")
          .replace("Z", " +0000"),
      }),
    ),
  );
  const result = await collectNativeCrashEvidence({
    pid: 123,
    executable: "Mosey",
    launchedAt: Date.now() - 1000,
    evidenceDirectory: output,
    reportsDirectory: directory,
    timeoutMs: 1000,
  });
  await completing;
  assert.deepEqual(result, { report: "native-crash-123.ips" });
});
