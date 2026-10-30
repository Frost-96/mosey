import { expect, onTestFinished, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { preparationSourceFixture } from "./support/preparation-source-fixture";
import {
  borrowPreparedApplication,
  createPreparationRun,
} from "./support/preparation";
import { recordMeasurement } from "./support/measurement";

test("a real asset failure drains the parallel native preparation before rejecting the generation", async () => {
  const root = await preparationSourceFixture();
  const trace = path.join(root, "native-branch.jsonl");
  const helper = path.join(root, "tools/build-dock-helper.ts");
  const original = await readFile(helper, "utf8");
  // Observe the real command branch in this owned source fixture. Both Swift
  // compilations and their original flags/signing still execute unchanged.
  await writeFile(
    helper,
    `import { appendFileSync as traceAppend, readFileSync as traceRead } from "node:fs";
traceAppend(${JSON.stringify(trace)}, JSON.stringify({ event: "started", pid: process.pid }) + "\\n");
${original}
for (const name of ["dock-live", "dock-runtime"])
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", path.resolve("build/native", name)]);
traceAppend(${JSON.stringify(trace)}, JSON.stringify({ event: "completed", pid: process.pid, receipts: ["receipt.json", "runtime-receipt.json"].map((name) => JSON.parse(traceRead(path.resolve("build/native", name), "utf8"))) }) + "\\n");
`,
  );
  await writeFile(path.join(root, "src/assets/corgi-idle.png"), "invalid PNG");
  const owner = await createPreparationRun({ sourceRoot: root });
  onTestFinished(() => owner.close());
  await expect(
    borrowPreparedApplication(owner.locator, "development"),
  ).rejects.toThrow(/Forge exited before readiness/);
  const events = await readFile(trace, "utf8").then(
    (text) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  recordMeasurement("production-branch-drain", { events });
  expect(events.map((event) => event.event)).toEqual(["started", "completed"]);
  const [product, diagnostic] = events[1].receipts;
  expect(product.flags).toEqual([
    "-O",
    "-target",
    "arm64-apple-macos15.0",
    "-parse-as-library",
  ]);
  expect(diagnostic.flags).toEqual(product.flags);
  expect(product.signature).toContain("Identifier=dev.frost.mosey.dock-helper");
  expect(diagnostic.signature).toContain(
    "Identifier=dev.frost.mosey.dock-runtime",
  );
  await owner.close();
  expect(() => process.kill(events[0].pid, 0)).toThrow();
});
