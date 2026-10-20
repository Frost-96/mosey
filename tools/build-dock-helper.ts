import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const directory = path.resolve("build/native");
await mkdir(directory, { recursive: true });
const binary = path.join(directory, "dock-live");
const source = path.resolve("probes/dock-live.swift");
const flags = ["-O", "-target", "arm64-apple-macos15.0", "-parse-as-library"];
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
  [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "dev.frost.mosey.dock-helper",
    binary,
  ],
  { stdio: "inherit" },
);
const signature = spawnSync("/usr/bin/codesign", ["-dvvv", binary], {
  encoding: "utf8",
  timeout: 5000,
}).stderr;
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
await writeFile(
  path.join(directory, "receipt.json"),
  JSON.stringify(
    {
      sourceSHA256: sha(await readFile(source)),
      buildHelperSHA256: sha(await readFile(binary)),
      swiftVersion: execFileSync("/usr/bin/xcrun", ["swiftc", "--version"], {
        encoding: "utf8",
      }).trim(),
      flags,
      signature,
    },
    null,
    2,
  ),
);
