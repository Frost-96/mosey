import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test } from "vitest";
import { scenarioGroups } from "./scenarios";

test.each([
  {
    name: "a registered group that no project runs",
    additionalFiles: ["tests/new-scenario.test.ts"],
    mutation:
      'Object.assign(scenarioGroups, { addedGroup: ["tests/new-scenario.test.ts"] });',
    error: '"unassigned":["tests/new-scenario.test.ts"]',
  },
  {
    name: "a group assigned to two projects in the same mode",
    additionalFiles: [],
    mutation:
      'testProjects["lifecycle-development"].files = scenarioGroups.application;',
    error:
      '"duplicateCoverage":[{"mode":"development","file":"tests/app.test.ts"}',
  },
])(
  "the inventory command rejects $name",
  async ({ additionalFiles, mutation, error }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mosey-inventory-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    for (const file of [
      ...Object.values(scenarioGroups).flat(),
      ...additionalFiles,
    ]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "");
    }
    await writeFile(
      path.join(root, "tests/scenarios.ts"),
      (await readFile("tests/scenarios.ts", "utf8")) + `\n${mutation}\n`,
    );
    await mkdir(path.join(root, "tools"));
    await writeFile(
      path.join(root, "tools/check-test-inventory.ts"),
      await readFile("tools/check-test-inventory.ts", "utf8"),
    );

    await expect(
      promisify(execFile)(process.execPath, ["tools/check-test-inventory.ts"], {
        cwd: root,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(error),
    });
  },
);
