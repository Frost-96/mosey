import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { closeSettings, openSettings } from "./support/settings";

// Harness acceptance stays outside the frozen business matrix. Its observables
// are the real app, owned files/processes and the run's preparation receipts.
test("independent settings and visibility sessions borrow one preparation across a real restart", async () => {
  const first = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      visibility: "visible",
      size: 160,
    },
  });
  const initial = await first.launch();
  const settings = await openSettings(initial.app, { run: first.run });
  expect(
    await first.run("read-size", () =>
      settings
        .getByRole("button", { name: "中（默认）" })
        .getAttribute("aria-pressed"),
    ),
  ).toBe("true");
  await closeSettings(initial.app, { run: first.run });
  const initialPid = initial.app.process().pid;
  await first.quit();
  const restarted = await first.launch();
  expect(restarted.app.process().pid).not.toBe(initialPid);
  expect(
    (await restarted.renderer.waitUntilReady({ paintedPixels: 600 }))
      .presentation.visibility,
  ).toBe("visible");
  await first.quit();
  await first.close();

  const second = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "whale",
      visibility: "hidden",
      size: 240,
    },
  });
  const hidden = await second.launch();
  expect((await hidden.renderer.waitUntilReady()).visible).toBe(false);
  expect(second.profile).not.toBe(first.profile);
  expect(hidden.app.process().pid).not.toBe(initialPid);
  await second.quit();
  await second.close();

  const entries = await Promise.all(
    [first, second].map(async (session) =>
      (await readFile(path.join(session.evidence, "progress.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ),
  );
  const identities = entries.map(
    (rows) =>
      rows.find((row) => row.event === "application-variant").preparationId,
  );
  expect(identities[0]).toBeTruthy();
  expect(identities[1]).toBe(identities[0]);
});
