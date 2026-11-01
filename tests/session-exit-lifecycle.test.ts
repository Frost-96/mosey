import { expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";

test("normal Quit refuses an application that exited before the request", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    isolateAppIdentity: true,
  });
  const { app } = await session.launch();
  const child = app.process();
  // Exit through the real public process boundary before asking the owner to
  // exercise Quit. The disconnected driver's response is not the exit oracle.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0);
  expect(child.signalCode).toBe(null);
  await expect(session.quit()).rejects.toThrow(/already exited before Quit/);
  const journal = await readFile(
    path.join(session.evidence, "progress.jsonl"),
    "utf8",
  );
  expect(journal).not.toContain('"event":"normal-exit-complete"');
});

test("a rejected Quit request retains its original error when the app misses the exit deadline", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    isolateAppIdentity: true,
  });
  const { app } = await session.launch();
  const child = app.process();
  const original = new Error("Quit driver request failed before dispatch");
  const failure = await session
    .quit({ action: () => Promise.reject(original) })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({
    message: "normal-exit did not complete within 10000ms",
    cause: original,
  });
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  await expect(session.launch()).rejects.toThrow(/closed|cancelled/);
  const journal = (
    await readFile(path.join(session.evidence, "progress.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    journal.find((row) => row.event === "quit-acknowledgement-failed").detail,
  ).toBe(original.stack);
  expect(journal.some((row) => row.event === "normal-exit-complete")).toBe(
    false,
  );
});

test("normal Quit accepts real exit zero after its driver acknowledgement rejects", async () => {
  const session = await createPetTestSession({ dock: "empty" });
  const { app } = await session.launch();
  const child = app.process();
  const evaluate = app.evaluate.bind(app);
  const acknowledgement = vi
    .spyOn(app, "evaluate")
    .mockImplementation((...args) => {
      // Deliver the real product request, then lose only the transport receipt.
      void evaluate(...args).catch(() => {});
      return Promise.reject(new Error("Quit acknowledgement disconnected"));
    });
  try {
    await session.quit();
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBe(null);
    await session.close();
  } finally {
    acknowledgement.mockRestore();
  }
});
