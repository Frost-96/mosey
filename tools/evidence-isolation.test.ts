import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("later mode/scale projects retain earlier settings failure evidence", async (t) => {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "tests"));
  // Exercise the real progress writer and failure/cleanup hooks. Acquisition
  // fails before any Electron launch, so this regression also runs on Ubuntu.
  await copyFile(
    path.join(repository, "tests/settings.test.ts"),
    path.join(root, "tests/settings.test.ts"),
  );
  for (const directory of ["tests/support", "node_modules", "src"])
    await symlink(path.join(repository, directory), path.join(root, directory));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    path.join(root, "probe.setup.ts"),
    `import { vi } from "vitest";
vi.mock(${JSON.stringify(path.join(repository, "tests/support/forge.ts"))}, () => ({
  startForge: async () => { throw new Error("intentional evidence probe"); },
}));
vi.mock("node:child_process", () => ({
  execFileSync: () => { throw new Error("intentional evidence probe"); },
}));
`,
  );
  await writeFile(
    path.join(root, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";
import { applicationProject } from ${JSON.stringify(path.join(repository, "vitest.config.ts"))};
export default defineConfig({
  test: {
    maxWorkers: 1, fileParallelism: false, bail: 0,
    testNamePattern: "^settings owns presets,",
    reporters: ["json"], outputFile: "results.json",
    projects: ["development", "packaged"].flatMap(mode => ["1", "2"].map(scale => {
      const project = applicationProject(mode, scale);
      return { test: { ...project.test, setupFiles: ["./probe.setup.ts"] } };
    })),
  },
});
`,
  );
  const result = spawnSync(
    process.execPath,
    [path.join(repository, "node_modules/vitest/vitest.mjs"), "run"],
    { cwd: root, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(
    await readFile(path.join(root, "results.json"), "utf8"),
  );
  assert.equal(report.numFailedTests, 4, result.stdout + result.stderr);
  for (const module of report.testResults) {
    const failure = module.assertionResults.find(
      (test: { status: string }) => test.status === "failed",
    );
    assert.match(
      failure.failureMessages.join("\n"),
      /intentional evidence probe/,
    );
  }
  const output = path.join(root, "test-results");
  const progress = (await readdir(output, { recursive: true })).filter((file) =>
    file.endsWith("-settings-progress.json"),
  );
  assert.equal(
    progress.length,
    4,
    "Every mode/scale must retain its own evidence",
  );
  for (const mode of ["development", "packaged"])
    for (const scale of ["1", "2"]) {
      const stages = JSON.parse(
        await readFile(
          path.join(
            output,
            `${mode}-${scale}x`,
            `${mode}-settings-progress.json`,
          ),
          "utf8",
        ),
      );
      assert.equal(stages.at(-1).stage, "test failed");
    }
});
