import { test, expect } from "vitest";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { nativeRuntimeFixture } from "./support/native-runtime";

test("a substituted Dock producer changes only its owned application copy", async () => {
  let prepared = false;
  const session = await createPetTestSession({
    preferences: { version: 3, visibility: "visible", size: 160 },
    dock: {
      name: "isolation-script",
      async prepare({ root, evidence, run }) {
        prepared = true;
        const input = path.join(root, "observation.json");
        await run("write-isolated-input", () => writeFile(input, "null"));
        await run("initial-producer-ledger", () =>
          writeFile(path.join(evidence, "producer-pids.jsonl"), ""),
        );
        return `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(path.join(evidence, "producer-pids.jsonl"))}, process.pid + '\\n');
console.log(JSON.stringify({type:'environment',protocol:1,processID:process.pid,parentPID:process.ppid}));
const start = performance.now(); let sequence = 0;
setInterval(() => console.log(JSON.stringify({type:'observation',elapsed:(performance.now()-start)/1000,sequence:++sequence,sourceAgeSeconds:0,callbackAgeSeconds:0,idle:false,reason:'alpha_empty',observation:JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8'))})),100);
`;
      },
    },
  });
  expect(prepared).toBe(true);
  await session.launch();
  await expect
    .poll(() =>
      session.run("producer-pid", () =>
        readFile(path.join(session.evidence, "producer-pids.jsonl"), "utf8"),
      ),
    )
    .toMatch(/^(?:\d+\n)+$/);
  const pids = (
    await session.run("producer-pids", () =>
      readFile(path.join(session.evidence, "producer-pids.jsonl"), "utf8"),
    )
  )
    .trim()
    .split("\n")
    .map(Number);
  await session.quit();
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  await session.close();
  const receipt = JSON.parse(
    await readFile(
      path.join(session.evidence, "native-isolation.json"),
      "utf8",
    ),
  );
  expect(receipt.after).toEqual(receipt.before);
  expect(receipt.diagnosticAfter).toEqual(receipt.diagnosticBefore);
});

test("the native Receiver producer owns its compiler cache and exits with its session", async () => {
  let ledger = "";
  const session = await createPetTestSession({
    dock: {
      name: "native-receiver-source",
      async prepare({ root, evidence, run }) {
        const input = path.join(root, "input.json");
        ledger = path.join(evidence, "native-producer-events.jsonl");
        await run("native-source-input", () =>
          writeFile(input, JSON.stringify({ revision: 1, observation: null })),
        );
        await run("native-source-ledger", () => writeFile(ledger, ""));
        const binary = await nativeRuntimeFixture(root, input, ledger);
        expect(
          (
            await run("owned-native-cache", () =>
              stat(path.join(root, "swift-module-cache")),
            )
          ).isDirectory(),
        ).toBe(true);
        const receipt = await run("native-receipt", () =>
          readFile(path.join(root, "native-source-fixture-receipt.json")),
        );
        await run("retain-native-receipt", () =>
          writeFile(
            path.join(evidence, "native-source-fixture-receipt.json"),
            receipt,
          ),
        );
        return binary;
      },
    },
  });
  const { app } = await session.launch();
  await expect
    .poll(
      () =>
        session.run("native-capability", () =>
          app.evaluate(
            ({ Menu }) =>
              Menu.getApplicationMenu()!.getMenuItemById("dock-runtime-status")!
                .label,
          ),
        ),
      { timeout: 15000 },
    )
    .toBe("Dock interaction waiting for visible Dock");
  await session.quit();
  const rows = (
    await session.run("native-process-exits", () => readFile(ledger, "utf8"))
  )
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  const pids = rows
    .filter((row) => row.event === "spawn")
    .map((row) => row.pid);
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) {
    expect(
      rows.some(
        (row) => row.pid === pid && row.event === "exit" && row.code === 0,
      ),
    ).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }
  await session.close();
});
