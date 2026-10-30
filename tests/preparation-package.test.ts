import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  borrowPreparedApplication,
  createPreparationRun,
} from "./support/preparation";
import { preparationSourceFixture } from "./support/preparation-source-fixture";

test("a signed package without its producer manifest is refused before a scenario can borrow it", async () => {
  const root = await preparationSourceFixture();
  const bundle = path.join(root, "out/Mosey-darwin-arm64/Mosey.app");
  await mkdir(path.dirname(bundle), { recursive: true });
  execFileSync(
    "/usr/bin/ditto",
    [path.resolve("out/Mosey-darwin-arm64/Mosey.app"), bundle],
    { timeout: 30000 },
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", bundle],
    { timeout: 30000 },
  );
  const owner = await createPreparationRun({ sourceRoot: root });
  onTestFinished(() => owner.close());
  const result = await borrowPreparedApplication(
    owner.locator,
    "packaged",
  ).then(
    async (lease) => {
      await lease.release();
      return { accepted: true };
    },
    (error: unknown) => ({ error }),
  );
  expect(result).toMatchObject({
    error: expect.objectContaining({
      message: expect.stringMatching(/package.*manifest/i),
    }),
  });
});
