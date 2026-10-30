import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  copyPreparationInputs,
  digest,
  producerIdentity,
  sourceIdentity,
  treeDigest,
} from "./preparation-inputs.ts";
import {
  measure,
  measurementDirectory,
  recordMeasurement,
} from "../tests/support/measurement.ts";

const bundleRelative = "out/Mosey-darwin-arm64/Mosey.app";
const nativeDefinitions = [
  {
    name: "dock-live",
    source: "native/macos/dock-live.swift",
    receipt: "receipt.json",
    identifier: "dev.frost.mosey.dock-helper",
  },
  {
    name: "dock-runtime",
    source: "native/macos/dock-runtime.swift",
    receipt: "runtime-receipt.json",
    identifier: "dev.frost.mosey.dock-runtime",
  },
];
const nativeFlags = [
  "-O",
  "-target",
  "arm64-apple-macos15.0",
  "-parse-as-library",
];
const command = (executable: string, args: string[]) =>
  execFileSync(executable, args, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function signature(file: string, identifier: string) {
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", file]);
  const result = spawnSync("/usr/bin/codesign", ["-dvvv", file], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Cannot inspect signature: ${file}`, {
      cause: result.error,
    });
  const actual = result.stderr.match(/^Identifier=(.+)$/m)?.[1];
  const cdHash = result.stderr.match(/^CDHash=(.+)$/m)?.[1];
  if (actual !== identifier || !cdHash)
    throw new Error(`Unexpected package signature identity: ${file}`);
  return { identifier: actual, cdHash };
}

export type PackageArtifact = {
  digest: string;
  asar: string;
  runtime: { electron: string; binary: string; architecture: string };
  application: { identifier: string; cdHash: string };
  minimumMacOS: string;
  native: Record<
    string,
    {
      source: string;
      receipt: string;
      buildBinary: string;
      packagedBinary: string;
      signature: { identifier: string; cdHash: string };
    }
  >;
};
export type PackageManifest = {
  schema: "mosey-package-v1";
  preparationId: string;
  entry: "pnpm package:mac";
  source: Awaited<ReturnType<typeof sourceIdentity>>;
  producer: Awaited<ReturnType<typeof producerIdentity>>;
  target: { platform: "darwin"; architecture: "arm64" };
  artifact: PackageArtifact;
};

async function inspectProducedPackage(
  root: string,
  producer: PackageManifest["producer"],
): Promise<PackageArtifact> {
  const bundle = path.join(root, bundleRelative);
  const plist = (file: string, key: string) =>
    command("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, file]);
  const info = path.join(bundle, "Contents/Info.plist");
  const framework = path.join(
    bundle,
    "Contents/Frameworks/Electron Framework.framework/Versions/A",
  );
  const electron = plist(
    path.join(framework, "Resources/Info.plist"),
    "CFBundleVersion",
  );
  const minimumMacOS = plist(info, "LSMinimumSystemVersion");
  const architecture = command("/usr/bin/lipo", [
    "-archs",
    path.join(framework, "Electron Framework"),
  ]);
  if (
    electron !== producer.versions.electron ||
    minimumMacOS !== "15.0" ||
    architecture !== "arm64" ||
    plist(info, "CFBundleIdentifier") !== "dev.frost.mosey"
  )
    throw new Error(
      "The produced package does not match its declared runtime/target",
    );
  const native: PackageArtifact["native"] = {};
  for (const helper of nativeDefinitions) {
    const source = digest(await readFile(path.join(root, helper.source)));
    const beforeSigning = path.join(root, "build/native", helper.name);
    const binary = path.join(bundle, "Contents/Resources/native", helper.name);
    const receiptBytes = await readFile(
      path.join(bundle, "Contents/Resources/native", helper.receipt),
    );
    const receipt = JSON.parse(receiptBytes.toString());
    const buildBinary = digest(await readFile(beforeSigning));
    if (
      receipt.sourceSHA256 !== source ||
      receipt.buildHelperSHA256 !== buildBinary ||
      receipt.swiftVersion !== producer.native.version ||
      JSON.stringify(receipt.flags) !== JSON.stringify(nativeFlags)
    )
      throw new Error(
        `Native build receipt does not match actual producer inputs: ${helper.name}`,
      );
    signature(beforeSigning, helper.identifier);
    native[helper.name] = {
      source,
      receipt: digest(receiptBytes),
      buildBinary,
      packagedBinary: digest(await readFile(binary)),
      signature: signature(binary, helper.identifier),
    };
  }
  return {
    digest: await treeDigest(bundle),
    asar: digest(
      await readFile(path.join(bundle, "Contents/Resources/app.asar")),
    ),
    runtime: {
      electron,
      binary: digest(
        await readFile(path.join(framework, "Electron Framework")),
      ),
      architecture,
    },
    application: signature(bundle, "dev.frost.mosey"),
    minimumMacOS,
    native,
  };
}

// Called before the genuine Forge package command, never to certify an already
// built/qualified app. The command gets a private source/install generation;
// only its successful output can be published with these captured inputs.
export async function stagePackagePreparation(
  sourceRoot: string,
  preparationId: string,
) {
  const inputs = await measure(
    "package.identify",
    { preparationId },
    async () => ({
      source: await sourceIdentity(sourceRoot),
      producer: await producerIdentity(sourceRoot),
    }),
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-package-producer-"));
  const close = () =>
    measure("package.release", { preparationId }, () =>
      rm(root, { recursive: true, force: true }),
    );
  try {
    await measure("package.snapshot", { preparationId }, async () => {
      await copyPreparationInputs(sourceRoot, root, inputs.source);
      if (
        (await treeDigest(path.join(root, "node_modules"), ["."], true)) !==
        inputs.producer.dependencies
      )
        throw new Error(
          "Package dependency snapshot differs from the captured install",
        );
    });
    const evidence = measurementDirectory();
    if (evidence)
      await writeFile(
        path.join(evidence, "package-inputs.json"),
        JSON.stringify(inputs, null, 2),
      );
  } catch (error) {
    const cleanup = await close().then(
      () => undefined,
      (failure: unknown) => ({ failure }),
    );
    if (cleanup)
      throw new AggregateError(
        [error, cleanup.failure],
        "Package snapshot and cleanup failed",
        { cause: error },
      );
    throw error;
  }
  return {
    cwd: root,
    close,
    async publish() {
      return measure("package.manifest", { preparationId }, async () => {
        const artifact = await inspectProducedPackage(root, inputs.producer);
        const manifest: PackageManifest = {
          schema: "mosey-package-v1",
          preparationId,
          entry: "pnpm package:mac",
          ...inputs,
          target: { platform: "darwin", architecture: "arm64" },
          artifact,
        };
        const destination = path.join(sourceRoot, bundleRelative);
        await mkdir(path.dirname(destination), { recursive: true });
        await measure("package.publish", { preparationId }, async () => {
          await rm(destination, { recursive: true, force: true });
          execFileSync(
            "/usr/bin/ditto",
            [path.join(root, bundleRelative), destination],
            { timeout: 30000 },
          );
        });
        if ((await treeDigest(destination)) !== artifact.digest)
          throw new Error(
            "Published package differs from its signed producer output",
          );
        signature(destination, "dev.frost.mosey");
        const file = path.join(sourceRoot, "out/package-manifest.json");
        await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
        const evidence = measurementDirectory();
        if (evidence)
          await cp(file, path.join(evidence, "package-manifest.json"));
        recordMeasurement("package-manifest", {
          preparationId,
          sourceId: manifest.source.digest,
          producerId: manifest.producer.digest,
          artifactSHA256: artifact.digest,
        });
        return manifest;
      });
    },
  };
}
