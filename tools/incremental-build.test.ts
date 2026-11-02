import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareBuild } from "./incremental-build.ts";

test("reuse requires unchanged sources, toolchain and intact outputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "source");
  const output = path.join(root, "output");
  await mkdir(input);
  await mkdir(output);
  const source = path.join(input, "source.txt");
  const binary = path.join(output, "binary");
  await writeFile(source, "first");
  const options = {
    name: "fixture",
    inputs: [input],
    outputs: [output],
    identity: "compiler-1",
    directory: path.join(root, "build"),
  };
  async function rebuild() {
    const build = await prepareBuild(options);
    assert.equal(build.current, false);
    await writeFile(binary, await readFile(source));
    await chmod(binary, 0o755);
    await build.complete();
    assert.equal((await prepareBuild(options)).current, true);
  }
  await rebuild();
  await writeFile(source, "second");
  await rebuild();
  await writeFile(path.join(input, "new-source.txt"), "added input");
  await rebuild();
  await rm(path.join(input, "new-source.txt"));
  await rebuild();
  options.identity = "compiler-2";
  await rebuild();
  await writeFile(binary, "substituted native producer");
  await rebuild();
  await chmod(binary, 0o644);
  await rebuild();
  await rm(binary);
  await rebuild();
  await writeFile(
    path.join(options.directory, "incremental/fixture.json"),
    "{",
  );
  await rebuild();
  await rm(source);
  await assert.rejects(
    prepareBuild({ ...options, inputs: [source] }),
    /ENOENT/,
  );
});

test("failed or changing builds cannot create a reusable receipt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-build-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "source");
  const output = path.join(root, "output");
  await writeFile(input, "first");
  const options = {
    name: "fixture",
    inputs: [input],
    outputs: [output],
    identity: [],
    directory: path.join(root, "build"),
  };
  const missingOutput = await prepareBuild(options);
  await assert.rejects(missingOutput.complete(), /ENOENT/);
  assert.equal((await prepareBuild(options)).current, false);
  const changingInput = await prepareBuild(options);
  await writeFile(output, "old output");
  await writeFile(input, "second");
  await assert.rejects(changingInput.complete(), /inputs changed/);
  assert.equal((await prepareBuild(options)).current, false);
});
