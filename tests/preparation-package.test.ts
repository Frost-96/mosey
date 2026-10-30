import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  borrowPreparedApplication,
  createPreparationRun,
} from "./support/preparation";
import { createPetTestSession } from "./support/pet-session";
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

test("a genuine package is consumed without requiring the producer's SDK on this host", async () => {
  const root = await preparationSourceFixture();
  const bundle = path.join(root, "out/Mosey-darwin-arm64/Mosey.app");
  await mkdir(path.dirname(bundle), { recursive: true });
  execFileSync(
    "/usr/bin/ditto",
    [path.resolve("out/Mosey-darwin-arm64/Mosey.app"), bundle],
    { timeout: 30000 },
  );
  await cp(
    path.resolve("out/package-manifest.json"),
    path.join(root, "out/package-manifest.json"),
  );
  const owner = await createPreparationRun({ sourceRoot: root });
  onTestFinished(() => owner.close());
  const sdk = process.env.SDKROOT;
  try {
    // No compiler is needed to consume this genuine signed application. This
    // is a consumer setting, not a forged/rewritten producer manifest.
    process.env.SDKROOT = path.join(root, "unavailable-consumer-sdk");
    const session = await createPetTestSession({
      preparation: owner.locator,
      dock: "empty",
    });
    const launched = await session.launch();
    expect(
      (await launched.renderer.waitUntilReady({ paintedPixels: 600 })).visible,
    ).toBe(true);
    await session.quit();
    await session.close();
  } finally {
    if (sdk === undefined) delete process.env.SDKROOT;
    else process.env.SDKROOT = sdk;
  }
});

test("a borrowed package keeps immutable bytes and refuses a subsequently altered producer artifact", async () => {
  const root = await preparationSourceFixture();
  const bundle = path.join(root, "out/Mosey-darwin-arm64/Mosey.app");
  await mkdir(path.dirname(bundle), { recursive: true });
  execFileSync(
    "/usr/bin/ditto",
    [path.resolve("out/Mosey-darwin-arm64/Mosey.app"), bundle],
    { timeout: 30000 },
  );
  await cp(
    path.resolve("out/package-manifest.json"),
    path.join(root, "out/package-manifest.json"),
  );
  const owner = await createPreparationRun({ sourceRoot: root });
  onTestFinished(() => owner.close());
  const first = await borrowPreparedApplication(owner.locator, "packaged");
  onTestFinished(() => first.release());
  const original = await readFile(
    path.join(first.appRoot, "Contents/Resources/app.asar"),
  );
  await appendFile(
    path.join(bundle, "Contents/Resources/app.asar"),
    "altered producer output",
  );
  expect(
    (
      await readFile(path.join(first.appRoot, "Contents/Resources/app.asar"))
    ).equals(original),
  ).toBe(true);
  const next = await borrowPreparedApplication(owner.locator, "packaged").then(
    async (lease) => {
      await lease.release();
      return { accepted: true };
    },
    (error: unknown) => ({ error }),
  );
  expect(next).toMatchObject({
    error: expect.objectContaining({
      message: expect.stringMatching(/package.*(artifact|integrity|digest)/i),
    }),
  });
});

test.each(["source", "producer manifest"])(
  "a changed %s requires a genuine new package before borrowing",
  async (changed) => {
    const root = await preparationSourceFixture();
    const bundle = path.join(root, "out/Mosey-darwin-arm64/Mosey.app");
    await mkdir(path.dirname(bundle), { recursive: true });
    execFileSync(
      "/usr/bin/ditto",
      [path.resolve("out/Mosey-darwin-arm64/Mosey.app"), bundle],
      { timeout: 30000 },
    );
    const manifestFile = path.join(root, "out/package-manifest.json");
    await cp(path.resolve("out/package-manifest.json"), manifestFile);
    if (changed === "source") {
      await appendFile(
        path.join(root, "src/main.ts"),
        '\nconsole.log("different package source");\n',
      );
    } else {
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      delete manifest.producer.native.sdkVersion;
      await writeFile(manifestFile, JSON.stringify(manifest));
    }
    const owner = await createPreparationRun({ sourceRoot: root });
    onTestFinished(() => owner.close());
    const next = await borrowPreparedApplication(
      owner.locator,
      "packaged",
    ).then(
      async (lease) => {
        await lease.release();
        return { accepted: true };
      },
      (error: unknown) => ({ error }),
    );
    expect(next).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringMatching(
          changed === "source"
            ? /Package source inputs changed/
            : /manifest is incomplete or malformed/,
        ),
      }),
    });
  },
);
