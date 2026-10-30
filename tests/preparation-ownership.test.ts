import { execFileSync } from "node:child_process";
import { expect, onTestFinished, test } from "vitest";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  borrowPreparedApplication,
  createPreparationRun,
} from "./support/preparation";

test("cancellation keeps its original cause when a late release cannot reach the closed run", async () => {
  const owner = await createPreparationRun();
  await owner.close();
  const cancellation = new AbortController();
  const original = new Error("original scenario cancellation");
  const borrowing = borrowPreparedApplication(
    owner.locator,
    "development",
    cancellation.signal,
  );
  cancellation.abort(original);
  const failure = await borrowing.catch((error: unknown) => error);
  expect(failure).toMatchObject({ cause: original });
});

test("cancelling one in-flight borrower preserves the other and closing waits for its release", async () => {
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
  const owner = await createPreparationRun();
  const cancellation = new AbortController();
  const original = new Error("one scenario cancelled during preparation");
  const cancelled = borrowPreparedApplication(
    owner.locator,
    "development",
    cancellation.signal,
  );
  const rejected = expect(cancelled).rejects.toBe(original);
  const surviving = borrowPreparedApplication(owner.locator, "development");
  onTestFinished(async () => {
    await surviving.then(
      (lease) => lease.release(),
      () => undefined,
    );
    await owner.close();
  });
  await expect
    .poll(async () =>
      (await events())
        .slice(before)
        .some(
          (row) =>
            row.event === "start" && row.phase === "preparation.identify",
        ),
    )
    .toBe(true);
  cancellation.abort(original);
  await rejected;
  const lease = await surviving;
  const main = await readFile(
    path.join(lease.appRoot, ".vite/build/main.mjs"),
    "utf8",
  );
  const url = main.match(/http:\/\/localhost:\d+/)?.[0];
  expect(url).toBeTruthy();
  expect(await (await fetch(url!)).text()).toContain("<title>Mosey</title>");
  const closing = owner.close();
  await expect(
    borrowPreparedApplication(owner.locator, "development"),
  ).rejects.toThrow(/closed/);
  expect(await (await fetch(url!)).text()).toContain("<title>Mosey</title>");
  await lease.release();
  await closing;
  await expect(fetch(url!)).rejects.toThrow();
  await expect(access(lease.appRoot)).rejects.toThrow();
  const prepared = (await events())
    .slice(before)
    .filter((row) => row.event === "end" && row.phase === "forge.prepare");
  expect(prepared).toEqual([
    expect.objectContaining({
      outcome: "passed",
      preparationId: lease.preparationId,
    }),
  ]);
});

test("closing a run during real Forge preparation rejects its pending borrow and reaps the preparation group", async () => {
  const file = path.join(
    process.env.MOSEY_MEASUREMENT_ROOT!,
    process.env.MOSEY_MEASUREMENT_RUN_ID!,
    "events.jsonl",
  );
  const events = async () =>
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const before = (await events()).length;
  const owner = await createPreparationRun();
  const borrowing = borrowPreparedApplication(owner.locator, "development");
  const failure = borrowing.catch((error: unknown) => error);
  onTestFinished(async () => {
    await borrowing.then(
      (lease) => lease.release(),
      () => undefined,
    );
    await owner.close();
  });
  await expect
    .poll(
      async () =>
        (await events())
          .slice(before)
          .some((row) => row.event === "forge-process"),
      { timeout: 30000 },
    )
    .toBe(true);
  const closing = owner.close();
  expect(await failure).toMatchObject({
    message: expect.stringMatching(/closed/),
  });
  await closing;
  await expect(
    access(path.dirname(owner.locator.socketPath)),
  ).rejects.toThrow();
  const rows = (await events()).slice(before);
  const groups = rows
    .filter((row) => row.event === "forge-process")
    .map((row) => row.groupId);
  const live = execFileSync("/bin/ps", ["-axo", "pgid=,state="], {
    encoding: "utf8",
    timeout: 5000,
  })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([group, state]) =>
        groups.includes(Number(group)) && !state!.startsWith("Z"),
    );
  expect(groups).toHaveLength(1);
  expect(live).toEqual([]);
  expect(rows.some((row) => row.event === "preparation-ready")).toBe(false);
});
