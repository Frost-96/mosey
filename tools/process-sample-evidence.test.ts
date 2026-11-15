import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { sampleProcess } from "../tests/support/process-sample-evidence.ts";

// A stand-in with /usr/bin/sample's argument shape: <pid> <seconds> -file <path>.
async function fixture(t: TestContext, body: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mosey-sample-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, "sample");
  await writeFile(command, `#!/bin/sh\n${body}\n`);
  await chmod(command, 0o755);
  const evidenceDirectory = path.join(directory, "evidence");
  await mkdir(evidenceDirectory);
  return { command, evidenceDirectory };
}

test("an unresponsive application's stacks are saved as named evidence", async (t) => {
  const { command, evidenceDirectory } = await fixture(
    t,
    'printf "Main Thread stack of %s for %ss" "$1" "$2" > "$4"',
  );
  const result = await sampleProcess({
    pid: 4321,
    name: "unresponsive-main",
    evidenceDirectory,
    command,
  });
  assert.deepEqual(result, { report: "unresponsive-main-4321.txt" });
  assert.equal(
    await readFile(path.join(evidenceDirectory, result.report!), "utf8"),
    "Main Thread stack of 4321 for 2s",
  );
});

test("an unavailable sampler reports why instead of replacing the failure", async (t) => {
  const { evidenceDirectory } = await fixture(t, "exit 0");
  const result = await sampleProcess({
    pid: 4321,
    name: "unresponsive-main",
    evidenceDirectory,
    command: path.join(evidenceDirectory, "missing-sample"),
  });
  assert.match(result.unavailable ?? "", /ENOENT/);
  assert.equal(result.report, undefined);
});

test("a sampler that never finishes is abandoned at its deadline", async (t) => {
  const { command, evidenceDirectory } = await fixture(t, "exec sleep 30");
  const started = performance.now();
  const result = await sampleProcess({
    pid: 4321,
    name: "unresponsive-main",
    evidenceDirectory,
    command,
    timeoutMs: 300,
  });
  assert.ok(performance.now() - started < 3000);
  assert.deepEqual(result, {
    unavailable: "Process sample exceeded its 300ms deadline",
  });
});
