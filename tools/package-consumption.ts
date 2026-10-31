import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  buildEnvironmentKeys,
  digest,
  type installedIdentity,
  type sourceIdentity,
  treeDigest,
} from "./preparation-inputs.ts";
import {
  bundleRelative,
  nativeDefinitions,
  nativeFlags,
  signature,
} from "./package-preparation.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1);
const signedIdentity = z.strictObject({
  identifier: text,
  cdHash: z.string().regex(/^[a-f0-9]{40}$/),
});
const nativeArtifact = z.strictObject({
  source: hash,
  receipt: hash,
  buildBinary: hash,
  packagedBinary: hash,
  signature: signedIdentity,
});
const manifestSchema = z.strictObject({
  schema: z.literal("mosey-package-v1"),
  preparationId: z.uuid(),
  entry: z.literal("pnpm package:mac"),
  source: z.strictObject({
    schema: z.literal("mosey-production-inputs-v1"),
    entries: z.array(text).min(1),
    digest: hash,
  }),
  producer: z.strictObject({
    schema: z.literal("mosey-producer-v1"),
    node: text,
    nodeBinary: hash,
    pnpm: text,
    pnpmLauncher: hash,
    pnpmBinary: hash,
    versions: z.record(text, text),
    dependencies: hash,
    platform: z.literal("darwin"),
    architecture: z.literal("arm64"),
    native: z.strictObject({
      compiler: text,
      compilerSHA256: hash,
      version: text,
      developer: text,
      sdk: text,
      sdkVersion: text,
      sdkBuild: text,
    }),
    environment: z.record(z.enum(buildEnvironmentKeys), hash.nullable()),
    viteEnvironment: hash,
    digest: hash,
  }),
  target: z.strictObject({
    platform: z.literal("darwin"),
    architecture: z.literal("arm64"),
  }),
  artifact: z.strictObject({
    digest: hash,
    asar: hash,
    runtime: z.strictObject({
      electron: text,
      binary: hash,
      architecture: z.literal("arm64"),
    }),
    application: signedIdentity,
    minimumMacOS: z.literal("15.0"),
    native: z.strictObject({
      "dock-live": nativeArtifact,
      "dock-runtime": nativeArtifact,
    }),
  }),
});

const command = (executable: string, args: string[]) =>
  execFileSync(executable, args, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

// Every acquire checks current source, manifest and output bytes. A previous
// successful validation is not permission to reuse a subsequently altered app.
export async function identifyPackage(
  root: string,
  source: Awaited<ReturnType<typeof sourceIdentity>>,
  consumer: Awaited<ReturnType<typeof installedIdentity>>,
) {
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(root, "out/package-manifest.json"));
  } catch (error) {
    throw new Error("Package producer manifest is required before borrowing", {
      cause: error,
    });
  }
  const parsed = manifestSchema.safeParse(JSON.parse(bytes.toString()));
  if (!parsed.success)
    throw new Error("Package producer manifest is incomplete or malformed", {
      cause: parsed.error,
    });
  const manifest = parsed.data;
  const { digest: producerDigest, ...producer } = manifest.producer;
  if (digest(JSON.stringify(producer)) !== producerDigest)
    throw new Error("Package producer manifest identity digest is invalid");
  if (
    source.digest !== manifest.source.digest ||
    JSON.stringify(source.entries) !== JSON.stringify(manifest.source.entries)
  )
    throw new Error(
      "Package source inputs changed; prepare the package again with pnpm package:mac",
    );
  if (
    consumer.platform !== manifest.target.platform ||
    consumer.architecture !== manifest.target.architecture ||
    consumer.node !== producer.node ||
    consumer.pnpm !== producer.pnpm ||
    JSON.stringify(consumer.versions) !== JSON.stringify(producer.versions) ||
    manifest.artifact.runtime.electron !== consumer.versions.electron ||
    Number(command("/usr/bin/sw_vers", ["-productVersion"]).split(".")[0]) < 15
  )
    throw new Error(
      "Package target/runtime is incompatible with this consumer",
    );
  // The signed product was built on the producer. Its SDK, binary paths,
  // dependency installation bytes and download transport are provenance;
  // consumer native/behavior derivatives record their own actual toolchain.
  const appRoot = path.join(root, bundleRelative);
  if ((await treeDigest(appRoot)) !== manifest.artifact.digest)
    throw new Error(
      "Package artifact integrity differs from the producer manifest",
    );
  return { manifest, manifestSHA256: digest(bytes), appRoot };
}

export async function copyPackageGeneration(
  root: string,
  destination: string,
  identified: Awaited<ReturnType<typeof identifyPackage>>,
) {
  const { manifest } = identified;
  const { artifact } = manifest;
  const appRoot = path.join(destination, bundleRelative);
  await mkdir(path.dirname(appRoot), { recursive: true });
  execFileSync("/usr/bin/ditto", [identified.appRoot, appRoot], {
    timeout: 30000,
  });
  if ((await treeDigest(appRoot)) !== artifact.digest)
    throw new Error(
      "Package artifact changed while copying its immutable generation",
    );
  await verifyPackageArtifact(root, appRoot, manifest);
  return appRoot;
}

export async function verifyPackageArtifact(
  root: string,
  appRoot: string,
  manifest: Awaited<ReturnType<typeof identifyPackage>>["manifest"],
) {
  const { artifact } = manifest;
  const actualSignature = signature(appRoot, "dev.frost.mosey");
  if (JSON.stringify(actualSignature) !== JSON.stringify(artifact.application))
    throw new Error(
      "Package application signature differs from its producer manifest",
    );
  const resources = path.join(appRoot, "Contents/Resources");
  if (
    digest(await readFile(path.join(resources, "app.asar"))) !== artifact.asar
  )
    throw new Error("Package ASAR digest differs from its producer manifest");
  const plist = (file: string, key: string) =>
    command("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, file]);
  const framework = path.join(
    appRoot,
    "Contents/Frameworks/Electron Framework.framework/Versions/A",
  );
  const runtime = path.join(framework, "Electron Framework");
  const runtimeBytes = await readFile(runtime);
  if (
    plist(path.join(appRoot, "Contents/Info.plist"), "CFBundleIdentifier") !==
      "dev.frost.mosey" ||
    plist(
      path.join(appRoot, "Contents/Info.plist"),
      "LSMinimumSystemVersion",
    ) !== artifact.minimumMacOS ||
    plist(path.join(framework, "Resources/Info.plist"), "CFBundleVersion") !==
      artifact.runtime.electron ||
    runtimeBytes.length < 8 ||
    runtimeBytes.readUInt32LE(0) !== 0xfeedfacf ||
    runtimeBytes.readUInt32LE(4) !== 0x0100000c ||
    digest(runtimeBytes) !== artifact.runtime.binary
  )
    throw new Error(
      "Package runtime bytes/target differ from its producer manifest",
    );
  for (const helper of nativeDefinitions) {
    const recorded = artifact.native[helper.name];
    const binary = path.join(resources, "native", helper.name);
    const receiptBytes = await readFile(
      path.join(resources, "native", helper.receipt),
    );
    const receipt = JSON.parse(receiptBytes.toString());
    if (
      digest(await readFile(path.join(root, helper.source))) !==
        recorded.source ||
      digest(receiptBytes) !== recorded.receipt ||
      digest(await readFile(binary)) !== recorded.packagedBinary ||
      receipt.sourceSHA256 !== recorded.source ||
      receipt.buildHelperSHA256 !== recorded.buildBinary ||
      receipt.swiftVersion !== manifest.producer.native.version ||
      JSON.stringify(receipt.flags) !== JSON.stringify(nativeFlags) ||
      JSON.stringify(signature(binary, helper.identifier)) !==
        JSON.stringify(recorded.signature)
    )
      throw new Error(
        `Package native producer receipt differs: ${helper.name}`,
      );
  }
}
