import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { recordResponsiveness } from "../tests/support/responsiveness-evidence.ts";

// A process that answers probes until told to stall its only thread, as a
// blocked Electron main thread or renderer stops answering its driver.
const responder = `
process.on("message", (message) => {
  if (message === "ping") process.send({ pid: process.pid });
  if (message === "stall")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
process.send("ready");
`;

async function start(t: TestContext, directory: string, name: string) {
  const script = path.join(directory, `${name}.cjs`);
  await writeFile(script, responder);
  const child = fork(script, { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve) => child.once("message", resolve));
  return child;
}

const probe = (child: ChildProcess) => () =>
  new Promise((resolve) => {
    child.once("message", resolve);
    child.send("ping");
  });

const stall = (child: ChildProcess) => {
  child.send("stall");
  // The message is delivered before the next probe is queued behind it.
  return new Promise((resolve) => setTimeout(resolve, 100));
};

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
  const main = await start(t, directory, "main");
  const renderer = await start(t, directory, "renderer");
  const record = () =>
    recordResponsiveness({
      name: "failure-slider",
      evidenceDirectory: directory,
      main: { pid: main.pid, probe: probe(main) },
      renderers: { settings: probe(renderer) },
      deadlineMs: 300,
      sampleCommand,
    });
  const saved = async () =>
    JSON.parse(
      await readFile(path.join(directory, "failure-slider-trace.json"), "utf8"),
    );
  const sampled = (report: string) =>
    readFile(path.join(directory, report), "utf8");
  return { main, renderer, record, saved, sampled };
}

test("a stalled main process is reported as unresponsive with its stacks", async (t) => {
  const { main, record, saved, sampled } = await fixture(t);
  await stall(main);
  const trace = await record();
  assert.equal(trace.verdict, "main-unresponsive");
  assert.match(trace.main.unresponsive ?? "", /300ms deadline/);
  assert.equal(
    trace.sample?.report,
    `failure-slider-main-sample-${main.pid}.txt`,
  );
  assert.equal(
    await sampled(trace.sample!.report!),
    `Main Thread stack of ${main.pid}`,
  );
  assert.deepEqual(await saved(), trace);
});

test("a stalled renderer under an answering main process is told apart", async (t) => {
  const { main, renderer, record, saved, sampled } = await fixture(t);
  await stall(renderer);
  const trace = await record();
  assert.equal(trace.verdict, "renderer-unresponsive");
  assert.deepEqual(trace.main.value, { pid: main.pid });
  assert.match(trace.renderers.settings!.unresponsive ?? "", /300ms deadline/);
  assert.equal(
    await sampled(trace.sample!.report!),
    `Main Thread stack of ${main.pid}`,
  );
  assert.deepEqual(await saved(), trace);
});

test("an application that answers every probe keeps their results without sampling", async (t) => {
  const { main, renderer, record, saved } = await fixture(t);
  const trace = await record();
  assert.equal(trace.verdict, "responsive");
  assert.deepEqual(trace.main.value, { pid: main.pid });
  assert.deepEqual(trace.renderers.settings!.value, { pid: renderer.pid });
  assert.equal(trace.sample, undefined);
  assert.deepEqual(await saved(), trace);
});

test("a main process that fails its probe is not mistaken for an answering one", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mosey-responsive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = await recordResponsiveness({
    name: "failure-app",
    evidenceDirectory: directory,
    main: {
      pid: undefined,
      probe: () => Promise.reject(new Error("Target closed")),
    },
    renderers: { diagnostic: undefined },
    deadlineMs: 300,
  });
  assert.equal(trace.verdict, "main-unavailable");
  assert.match(trace.main.unavailable ?? "", /Target closed/);
  assert.match(trace.renderers.diagnostic!.unavailable ?? "", /not open/);
  assert.equal(trace.sample, undefined);
});
