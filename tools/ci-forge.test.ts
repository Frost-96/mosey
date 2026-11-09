import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("shared preparation spans projects, cleans up once, and fails only development when startup fails", async (t) => {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-ci-forge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "bin"));
  await mkdir(path.join(root, "build/native"), { recursive: true });
  await writeFile(
    path.join(root, "build/native/dock-runtime"),
    "fixture native runtime",
  );
  await symlink(
    path.join(repository, "node_modules"),
    path.join(root, "node_modules"),
  );
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    path.join(root, "probe.test.ts"),
    `
import { test, expect, inject } from "vitest";
import { startForge } from ${JSON.stringify(path.join(repository, "tests/support/forge.ts"))};
test("independent application channel", async () => {
  if (process.env.MOSEY_TEST_MODE === "packaged") return;
  const first = await startForge();
  await first();
  const second = await startForge();
  expect(inject("forgeServer").pid).toBeGreaterThan(0);
  await second();
});
`,
  );
  await writeFile(
    path.join(root, "vitest.config.ts"),
    `
import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  globalSetup: [${JSON.stringify(path.join(repository, "tests/support/ci-forge.ts"))}],
  maxWorkers: 1, fileParallelism: false,
  reporters: ["json"], outputFile: "results.json",
  projects: ["development", "packaged"].flatMap(mode => ["1", "2"].map(scale => ({
    test: { name: mode + "-" + scale + "x", include: ["probe.test.ts"],
      env: { MOSEY_TEST_MODE: mode, MOSEY_TEST_SCALE_FACTOR: scale } }
  })))
}});
`,
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(repository, "node_modules/vitest/vitest.mjs"), "run"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, PATH: path.join(root, "bin") },
      },
    );
  const failed = run();
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const failures = JSON.parse(
    await readFile(path.join(root, "results.json"), "utf8"),
  );
  assert.equal(failures.numFailedTests, 2);
  assert.equal(failures.numPassedTests, 2, "Packaged channels must still run");
  await writeFile(
    path.join(root, "bin/pnpm"),
    `#!${process.execPath}
import fs from "node:fs";
fs.appendFileSync("forge-launches.txt", process.pid + "\\n");
console.log("MOSEY_TEST_READY");
setInterval(() => {}, 1000);
`,
  );
  await chmod(path.join(root, "bin/pnpm"), 0o755);
  const passed = run();
  const successes = JSON.parse(
    await readFile(path.join(root, "results.json"), "utf8"),
  );
  assert.equal(
    passed.status,
    0,
    passed.stdout + passed.stderr + JSON.stringify(successes),
  );
  assert.equal(successes.numPassedTests, 4);
  const pids = (await readFile(path.join(root, "forge-launches.txt"), "utf8"))
    .trim()
    .split("\n")
    .map(Number);
  assert.equal(
    pids.length,
    1,
    "All development fixtures share one preparation",
  );
  assert.throws(() => process.kill(pids[0]!, 0), { code: "ESRCH" });
});
