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
