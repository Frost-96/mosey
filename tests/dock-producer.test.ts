import { test, expect } from "vitest";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { nativeRuntimeFixture } from "./support/native-runtime";
import { execFileSync } from "node:child_process";

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
      async prepare({ root, evidence, run, signal }) {
        const input = path.join(root, "input.json");
        ledger = path.join(evidence, "native-producer-events.jsonl");
        await run("native-source-input", () =>
          writeFile(input, JSON.stringify({ revision: 1, observation: null })),
        );
        await run("native-source-ledger", () => writeFile(ledger, ""));
        const binary = await nativeRuntimeFixture(root, input, ledger, {
          run,
          signal,
        });
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

test("cancelled native preparation cannot deliver a later producer and the next session is independent", async () => {
  const controller = new AbortController();
  let scratch = "";
  let delivered: Buffer | undefined;
  const preparing = createPetTestSession({
    signal: controller.signal,
    dock: {
      name: "cancelled-native-source",
      async prepare({ root, evidence, run, signal }) {
        scratch = root;
        const input = path.join(root, "input.json");
        await run("native-input-before-cancellation", () =>
          writeFile(input, JSON.stringify({ revision: 1, observation: null })),
        );
        // Cancellation lands between two actual fixture acquisitions. Native
        // preparation must reenter the session guard before its next operation.
        controller.abort(new Error("cancel before native compilation"));
        delivered = await nativeRuntimeFixture(
          root,
          input,
          path.join(evidence, "cancelled-native-events.jsonl"),
          { run, signal },
        );
        return delivered;
      },
    },
  });
  await expect(preparing).rejects.toThrow(/cancel/);
  expect(
    delivered?.byteLength ?? 0,
    "cancelled native preparation delivered an executable",
  ).toBe(0);
  await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  const next = await createPetTestSession({ dock: "empty" });
  await next.launch();
  await next.quit();
  await next.close();
});

test("cancelling an acquired native compiler records its exit and releases its owned group", async () => {
  const controller = new AbortController();
  let journal = "";
  let scratch = "";
  const preparing = createPetTestSession({
    signal: controller.signal,
    dock: {
      name: "cancelled-active-native-compiler",
      async prepare({ root, evidence, run, signal }) {
        scratch = root;
        const input = path.join(root, "input.json");
        const ledger = path.join(evidence, "cancelled-compiler-events.jsonl");
        journal = `${ledger}.compiler.jsonl`;
        await run("active-compiler-input", () =>
          writeFile(input, JSON.stringify({ revision: 1, observation: null })),
        );
        return nativeRuntimeFixture(root, input, ledger, { run, signal });
      },
    },
  });
  const outcome = preparing.then(
    (session) => ({ session, error: undefined }),
    (error: unknown) => ({ session: undefined, error }),
  );
  const records = async () => {
    if (!journal) return [];
    const text = await readFile(journal, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((row) => JSON.parse(row));
  };
  await expect
    .poll(
      async () =>
        (await records()).some((row) => row.event === "compiler-spawned"),
      { timeout: 30000 },
    )
    .toBe(true);
  const acquired = (await records()).find(
    (row) => row.event === "compiler-spawned",
  );
  expect(acquired.pid).toBeGreaterThan(0);
  controller.abort(new Error("cancel active native compiler"));
  const result = await outcome;
  expect(result.session).toBeUndefined();
  expect(result.error).toBeDefined();
  const exit = (await records()).find((row) => row.event === "compiler-exited");
  expect(exit).toMatchObject({
    pid: acquired.pid,
    code: null,
    signal: "SIGKILL",
    live: [],
  });
  const live = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,state="], {
    encoding: "utf8",
    timeout: 5000,
  })
    .split("\n")
    .filter((row) => {
      const fields = row.trim().split(/\s+/);
      return Number(fields[1]) === acquired.pid && !fields[2]!.startsWith("Z");
    });
  expect(live).toEqual([]);
  await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
});
