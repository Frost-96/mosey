import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("coverage gate rejects a missing, duplicated or unassigned application file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "tests"));
  for (const file of ["first", "second", "pixel-comparison"])
    await writeFile(path.join(root, "tests", `${file}.test.ts`), "");
  const modules = [
    "development-1x",
    "development-2x",
    "packaged-1x",
    "packaged-2x",
  ].flatMap((project) =>
    ["first", "second"].map((file) => ({
      project,
      file: `tests/${file}.test.ts`,
      tests: [{ state: "passed" }],
    })),
  );
  async function report(items: typeof modules) {
    for (let shard = 0; shard < 5; shard++) {
      const directory = path.join(root, "reports", String(shard));
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "ci-matrix.json"),
        JSON.stringify(items.filter((_, i) => i % 5 === shard)),
      );
    }
  }
  const run = () =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./check-ci-coverage.ts", import.meta.url)),
        path.join(root, "reports"),
      ],
      { cwd: root, encoding: "utf8" },
    );
  await report(modules);
  assert.equal(run().status, 0);
  await report(modules.slice(1));
  assert.notEqual(run().status, 0);
  await report([...modules, modules[0]!]);
  assert.match(run().stderr, /Duplicate validation/);
  await report(modules);
  await writeFile(path.join(root, "tests", "new.test.ts"), "");
  assert.notEqual(run().status, 0);
});
