import { expect, test } from "vitest";
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
