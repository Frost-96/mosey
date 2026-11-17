import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { recordResponsiveness } from "../tests/support/responsiveness-evidence.ts";

// Stands in for Electron: a main process owns its renderer and relays every
// renderer probe, as the UI thread routes CDP commands. Either one stalls its
// only thread on request; the wait is bounded so no orphan outlives the test.
const stall =
  "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000)";
const renderer = `
process.on("message", (message) => {
  if (message.stall) ${stall};
  else process.send({ id: message.id, pid: process.pid });
});
process.send("ready");
`;
const main = `
const renderer = require("node:child_process").fork(
  require("node:path").join(__dirname, "renderer.cjs"),
);
renderer.on("message", (message) => {
  if (message === "ready") process.send({ ready: renderer.pid });
  else process.send(message);
});
process.on("message", (message) => {
  if (message.stall === "main") ${stall};
  else if (message.to === "main") process.send({ id: message.id, pid: process.pid });
  else renderer.send(message);
});
`;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mosey-responsive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // /usr/bin/sample's argument shape: <pid> <seconds> -file <path>.
  const sampleCommand = path.join(directory, "sample");
  await writeFile(
    sampleCommand,
    '#!/bin/sh\nprintf "Main Thread stack of %s" "$1" > "$4"\n',
  );
  await chmod(sampleCommand, 0o755);
  await writeFile(path.join(directory, "renderer.cjs"), renderer);
  await writeFile(path.join(directory, "main.cjs"), main);
  const app: ChildProcess = fork(path.join(directory, "main.cjs"), {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const rendererPid = await new Promise<number>((resolve) =>
    app.once("message", (message: { ready: number }) => resolve(message.ready)),
  );
  t.after(() => {
    for (const pid of [app.pid!, rendererPid])
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
  });
  let next = 0;
  const probe = (to: "main" | "renderer") => () =>
    new Promise((resolve) => {
      const id = next++;
      const answer = (message: { id: number; pid: number }) => {
        if (message.id !== id) return;
        app.off("message", answer);
        resolve({ pid: message.pid });
      };
      app.on("message", answer);
      app.send({ to, id });
    });
  const stallProcess = (which: "main" | "renderer") => {
    app.send({ stall: which });
    // Delivered before any probe can queue behind it.
    return new Promise((resolve) => setTimeout(resolve, 100));
  };
  const record = () =>
    recordResponsiveness({
      name: "failure-slider",
      evidenceDirectory: directory,
      main: { pid: app.pid, probe: probe("main") },
      renderers: { settings: probe("renderer") },
      deadlineMs: 300,
      sampleCommand,
    });
  const saved = async () =>
    JSON.parse(
      await readFile(path.join(directory, "failure-slider-trace.json"), "utf8"),
    );
  const sampled = (report: string) =>
    readFile(path.join(directory, report), "utf8");
  return {
    mainPid: app.pid!,
    rendererPid,
    stallProcess,
    record,
    saved,
    sampled,
  };
}

test("a stalled main process silences every probe and keeps its stacks", async (t) => {
  const { mainPid, stallProcess, record, saved, sampled } = await fixture(t);
  await stallProcess("main");
  const trace = await record();
  assert.equal(trace.verdict, "main-unresponsive");
  assert.match(trace.main.unresponsive ?? "", /300ms deadline/);
  assert.match(trace.renderers.settings.unresponsive ?? "", /300ms deadline/);
  assert.equal(
    trace.sample?.report,
    `failure-slider-main-sample-${mainPid}.txt`,
  );
  assert.equal(
    await sampled(trace.sample!.report!),
    `Main Thread stack of ${mainPid}`,
  );
  assert.deepEqual(await saved(), trace);
});

test("a stalled renderer under an answering main process is told apart", async (t) => {
  const { mainPid, stallProcess, record, saved, sampled } = await fixture(t);
  await stallProcess("renderer");
  const trace = await record();
  assert.equal(trace.verdict, "renderer-unresponsive");
  assert.deepEqual(trace.main.value, { pid: mainPid });
  assert.match(trace.renderers.settings.unresponsive ?? "", /300ms deadline/);
  assert.equal(
    await sampled(trace.sample!.report!),
    `Main Thread stack of ${mainPid}`,
  );
  assert.deepEqual(await saved(), trace);
});

test("an application that answers every probe keeps their results without sampling", async (t) => {
  const { mainPid, rendererPid, record, saved } = await fixture(t);
  const trace = await record();
  assert.equal(trace.verdict, "responsive");
  assert.deepEqual(trace.main.value, { pid: mainPid });
  assert.deepEqual(trace.renderers.settings.value, { pid: rendererPid });
  assert.equal(trace.sample, undefined);
  assert.deepEqual(await saved(), trace);
});

test("a main process that cannot be probed is never reported as answering", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mosey-responsive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unlaunched = await recordResponsiveness({
    name: "failure-app",
    evidenceDirectory: directory,
    main: { pid: undefined, probe: undefined },
    renderers: { diagnostic: undefined },
  });
  assert.equal(unlaunched.verdict, "main-unavailable");
  assert.match(unlaunched.main.unavailable ?? "", /not open/);
  assert.match(unlaunched.renderers.diagnostic.unavailable ?? "", /not open/);
  assert.equal(unlaunched.sample, undefined);
  const failing = await recordResponsiveness({
    name: "failure-app",
    evidenceDirectory: directory,
    main: {
      pid: undefined,
      probe: () => Promise.reject(new Error("Target closed")),
    },
    // A failed main probe does not hide a renderer that stopped answering.
    renderers: { diagnostic: () => new Promise(() => {}) },
    deadlineMs: 300,
  });
  assert.equal(failing.verdict, "renderer-unresponsive");
  assert.match(failing.main.unavailable ?? "", /Target closed/);
});
