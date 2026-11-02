import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import path from "node:path";

const projects = [
  "development-1x",
  "development-2x",
  "packaged-1x",
  "packaged-2x",
];
const expected = new Set<string>();
for await (const file of glob("tests/*.test.ts")) {
  if (file === "tests/pixel-comparison.test.ts") continue;
  for (const project of projects) expected.add(`${project}/${file}`);
}
const seen = new Set<string>();
let reports = 0;
const summary: Record<string, Record<string, number>> = {};
for await (const file of glob("**/ci-matrix.json", { cwd: process.argv[2] })) {
  reports++;
  const modules = JSON.parse(
    await readFile(path.join(process.argv[2]!, file), "utf8"),
  ) as {
    project: string;
    file: string;
    tests: { state: string }[];
  }[];
  for (const module of modules) {
    const key = `${module.project}/${module.file}`;
    assert(expected.has(key), `Unexpected validation: ${key}`);
    assert(!seen.has(key), `Duplicate validation: ${key}`);
    seen.add(key);
    const counts = (summary[module.project] ??= {});
    for (const test of module.tests)
      counts[test.state] = (counts[test.state] ?? 0) + 1;
  }
}
assert.equal(reports, 5, "All five shard reports must be present");
assert.deepEqual(
  seen,
  expected,
  "Every application file must run in both modes and scales",
);
console.log(JSON.stringify({ modules: seen.size, summary }, null, 2));
