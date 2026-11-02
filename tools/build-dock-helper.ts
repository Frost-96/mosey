import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareBuild } from "./incremental-build.ts";

const directory = path.resolve("build/native");
const flags = ["-O", "-target", "arm64-apple-macos15.0", "-parse-as-library"];
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const xcrun = (...args: string[]) =>
  execFileSync("/usr/bin/xcrun", args, { encoding: "utf8" }).trim();
const toolchain = {
  compiler: xcrun("--find", "swiftc"),
  swiftVersion: xcrun("swiftc", "--version"),
  sdk: xcrun("--show-sdk-path"),
  sdkVersion: xcrun("--show-sdk-version"),
};
await mkdir(directory, { recursive: true });

async function buildHelper({
  sourceFile,
  outputName,
  identifier,
  receiptName,
}: {
  sourceFile: string;
  outputName: string;
  identifier: string;
  receiptName: string;
}) {
  const source = path.resolve(sourceFile);
  const binary = path.join(directory, outputName);
  const build = await prepareBuild({
    name: outputName,
    inputs: [source, "tools/build-dock-helper.ts"],
    outputs: [binary, path.join(directory, receiptName)],
    identity: { ...toolchain, flags, identifier },
  });
  if (build.current) return;
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      ...flags,
      "-module-cache-path",
      path.resolve("build/swift-module-cache"),
      source,
      "-o",
      binary,
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--sign", "-", "--identifier", identifier, binary],
    { stdio: "inherit" },
  );
  const signature = spawnSync("/usr/bin/codesign", ["-dvvv", binary], {
    encoding: "utf8",
    timeout: 5000,
  }).stderr;
  await writeFile(
    path.join(directory, receiptName),
    JSON.stringify(
      {
        sourceSHA256: sha(await readFile(source)),
        buildHelperSHA256: sha(await readFile(binary)),
        swiftVersion: toolchain.swiftVersion,
        flags,
        signature,
      },
      null,
      2,
    ),
  );
  await build.complete();
}

// Product and historical validation keep separate source, binary and signing
// identities; shared mechanics cannot overwrite the original probe's receipt.
await buildHelper({
  sourceFile: "native/macos/dock-live.swift",
  outputName: "dock-live",
  identifier: "dev.frost.mosey.dock-helper",
  receiptName: "receipt.json",
});
await buildHelper({
  sourceFile: "native/macos/dock-runtime.swift",
  outputName: "dock-runtime",
  identifier: "dev.frost.mosey.dock-runtime",
  receiptName: "runtime-receipt.json",
});
