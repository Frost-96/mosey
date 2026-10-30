import { expect, onTestFinished, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { preparationSourceFixture } from "./support/preparation-source-fixture";
import path from "node:path";
import {
  borrowPreparedApplication,
  createPreparationRun,
} from "./support/preparation";

test("changing real build inputs prepares a new generation while an old borrower keeps its renderer", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mosey-source-test-"));
  const cancellation = new AbortController();
  const owner = await createPreparationRun({ sourceRoot: root });
  const leases: Awaited<ReturnType<typeof borrowPreparedApplication>>[] = [];
  onTestFinished(async () => {
    cancellation.abort(new Error("Preparation scenario finished"));
    for (const lease of leases) await lease.release();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const name of [
    "src",
    "native",
    "tools",
    "node_modules",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "forge.config.ts",
    "vite.main.config.ts",
    "vite.preload.config.ts",
    "vite.renderer.config.ts",
    "tsconfig.json",
    "index.html",
    ".node-version",
    ".nvmrc",
  ])
    execFileSync(
      "/bin/cp",
      ["-cR", path.resolve(name), path.join(root, name)],
      { timeout: 30000 },
    );
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const main = await readFile(path.join(root, "src/main.ts"), "utf8");
  await writeFile(
    path.join(root, "index.html"),
    html.replace(/<title>.*?<\/title>/, "<title>Preparation A</title>"),
  );
  await writeFile(
    path.join(root, "src/main.ts"),
    `${main}\nconsole.log("preparation generation A");\n`,
  );
  cancellation.signal.throwIfAborted();
  const first = await borrowPreparedApplication(
    owner.locator,
    "development",
    cancellation.signal,
  );
  leases.push(first);
  const firstMain = await readFile(
    path.join(first.appRoot, ".vite/build/main.mjs"),
    "utf8",
  );
  const firstUrl = firstMain.match(/http:\/\/localhost:\d+/)?.[0];
  expect(firstUrl).toBeTruthy();
  expect(firstMain).toContain("preparation generation A");
  expect(await (await fetch(firstUrl!)).text()).toContain(
    "<title>Preparation A</title>",
  );
  await writeFile(
    path.join(root, "index.html"),
    html.replace(/<title>.*?<\/title>/, "<title>Preparation B</title>"),
  );
  await writeFile(
    path.join(root, "src/main.ts"),
    `${main}\nconsole.log("preparation generation B");\n`,
  );
  expect(await (await fetch(firstUrl!)).text()).toContain(
    "<title>Preparation A</title>",
  );
  const second = await borrowPreparedApplication(
    owner.locator,
    "development",
    cancellation.signal,
  );
  leases.push(second);
  expect(second.preparationId).not.toBe(first.preparationId);
  const secondMain = await readFile(
    path.join(second.appRoot, ".vite/build/main.mjs"),
    "utf8",
  );
  const secondUrl = secondMain.match(/http:\/\/localhost:\d+/)?.[0];
  expect(secondMain).toContain("preparation generation B");
  expect(secondUrl).not.toBe(firstUrl);
  expect(await (await fetch(secondUrl!)).text()).toContain(
    "<title>Preparation B</title>",
  );
  expect(await (await fetch(firstUrl!)).text()).toContain(
    "<title>Preparation A</title>",
  );
  const rows = (
    await readFile(
      path.join(
        process.env.MOSEY_MEASUREMENT_ROOT!,
        process.env.MOSEY_MEASUREMENT_RUN_ID!,
        "events.jsonl",
      ),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const ready = rows.filter(
    (row) =>
      row.event === "end" &&
      row.phase === "forge.prepare" &&
      row.outcome === "passed" &&
      [first.preparationId, second.preparationId].includes(row.preparationId),
  );
  expect(ready).toHaveLength(2);
});

test("a real native build failure rejects the changed input without destroying a valid generation", async () => {
  const eventsFile = path.join(
    process.env.MOSEY_MEASUREMENT_ROOT!,
    process.env.MOSEY_MEASUREMENT_RUN_ID!,
    "events.jsonl",
  );
  const events = async () =>
    (await readFile(eventsFile, "utf8"))
      .split("\n")
      .slice(0, -1)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const before = (await events()).length;
  const root = await preparationSourceFixture();
  const owner = await createPreparationRun({ sourceRoot: root });
  onTestFinished(() => owner.close());
  const first = await borrowPreparedApplication(owner.locator, "development");
  onTestFinished(() => first.release());
  const main = await readFile(
    path.join(first.appRoot, ".vite/build/main.mjs"),
    "utf8",
  );
  const url = main.match(/http:\/\/localhost:\d+/)?.[0];
  expect(url).toBeTruthy();
  const swift = path.join(root, "native/macos/dock-live.swift");
  const original = await readFile(swift, "utf8");
  await writeFile(swift, `${original}\nnot_a_swift_declaration(\n`);
  await expect(
    borrowPreparedApplication(owner.locator, "development"),
  ).rejects.toThrow(/Forge exited before readiness/);
  expect(await (await fetch(url!)).text()).toContain("<title>Mosey</title>");
  await writeFile(swift, original);
  const restored = await borrowPreparedApplication(
    owner.locator,
    "development",
  );
  onTestFinished(() => restored.release());
  expect(restored.preparationId).toBe(first.preparationId);
  expect(await (await fetch(url!)).text()).toContain("<title>Mosey</title>");
  const attempts = (await events())
    .slice(before)
    .filter((row) => row.event === "end" && row.phase === "forge.prepare");
  expect(attempts.map((row) => row.outcome)).toEqual(["passed", "failed"]);
});
