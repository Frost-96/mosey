import { expect, onTestFinished, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instrumentBehaviorApplication } from "./support/behavior-build";

// Failures at the owned-build boundary must leave the caller's input intact.
test.each([
  ["missing", "export const application = 'unrecognized entry';"],
  [
    "ambiguous",
    "launch(prefs, { dock, refreshMenus, publishSettings, bodyMenu }); other(prefs, { dock, refreshMenus, publishSettings, bodyMenu });",
  ],
])(
  "%s application bootstrap refuses controlled instrumentation",
  async (_name, source) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mosey-behavior-build-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "app"));
    await writeFile(
      path.join(root, "app/package.json"),
      JSON.stringify({ main: "main.mjs" }),
    );
    const entry = path.join(root, "app/main.mjs");
    await writeFile(entry, source);
    await expect(
      instrumentBehaviorApplication({ root, packaged: false }),
    ).rejects.toThrow("requires exactly one pet bootstrap");
    expect(await readFile(entry, "utf8")).toBe(source);
    await expect(
      access(path.join(root, "app/behavior-controller.mjs")),
    ).rejects.toThrow();
  },
);
