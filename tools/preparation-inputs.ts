import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  mkdir,
  rm,
} from "node:fs/promises";
import path from "node:path";

export const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

// Current production graph, not the Git index: dirty/untracked assets,
// additions and deletions count. Test/CI bookkeeping is not a build input.
const productionRoots = [
  "src",
  "native",
  "index.html",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "forge.config.ts",
  "vite.main.config.ts",
  "vite.preload.config.ts",
  "vite.renderer.config.ts",
  "tsconfig.json",
  ".node-version",
  ".nvmrc",
  "tools/build-assets.ts",
  "tools/build-whale-assets.ts",
  "tools/asset-hit-rows.ts",
  "tools/build-dock-helper.ts",
];
const volatileDependencies = new Set([
  ".vite",
  ".vite-temp",
  ".vitest",
  ".vitest-cache",
  ".cache",
  ".pnpm-store",
]);
const fileDigests = new Map<string, { stamp: string; value: string }>();

// ctime/inode/size/mode also participate; restoring mtime cannot hide a write.
// Contents, not timestamps, enter the identity. The cache is run-local only.
export async function treeDigest(
  root: string,
  entries = ["."],
  dependencies = false,
) {
  const rows: unknown[] = [];
  const visit = async (relative: string) => {
    const file = path.join(root, relative);
    const stat = await lstat(file, { bigint: true });
    if (stat.isSymbolicLink()) {
      const target = await readlink(file);
      const resolved = path.resolve(path.dirname(file), target);
      if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`))
        throw new Error(
          `Preparation input links outside its root: ${relative}`,
        );
      rows.push([relative, "link", target]);
    } else if (stat.isDirectory()) {
      rows.push([relative, "directory", Number(stat.mode & 0o777n)]);
      for (const name of (await readdir(file)).sort()) {
        if (
          dependencies &&
          (volatileDependencies.has(name) || name === ".DS_Store")
        )
          continue;
        await visit(path.join(relative, name));
      }
    } else if (stat.isFile()) {
      const stamp = [
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs,
        stat.mode,
      ].join(":");
      let cached = fileDigests.get(file);
      if (cached?.stamp !== stamp) {
        cached = { stamp, value: digest(await readFile(file)) };
        const after = await lstat(file, { bigint: true });
        if (
          [
            after.dev,
            after.ino,
            after.size,
            after.mtimeNs,
            after.ctimeNs,
            after.mode,
          ].join(":") !== stamp
        )
          throw new Error(
            `Preparation input changed while reading: ${relative}`,
          );
        fileDigests.set(file, cached);
      }
      rows.push([relative, "file", Number(stat.mode & 0o777n), cached.value]);
    } else throw new Error(`Unsupported preparation input: ${relative}`);
  };
  for (const entry of [...entries].sort()) await visit(entry);
  return digest(JSON.stringify(rows));
}

export async function sourceIdentity(root: string) {
  const entries = [
    ...productionRoots,
    ...(await readdir(root)).filter(
      (name) =>
        name === "public" ||
        /^\.env(?:\.|$)/.test(name) ||
        /^\.postcssrc(?:\.(?:json|yaml|yml|ts|cts|mts|js|cjs|mjs))?$/.test(
          name,
        ) ||
        /^postcss\.config\.(?:ts|cts|mts|js|cjs|mjs)$/.test(name),
    ),
  ].sort();
  return {
    schema: "mosey-production-inputs-v1",
    entries,
    digest: await treeDigest(root, entries),
  };
}

const observe = (command: string, args: string[]) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const binaryIdentity = async (file: string) => {
  const resolved = await realpath(file);
  await treeDigest(path.dirname(resolved), [path.basename(resolved)]);
  return fileDigests.get(resolved)!.value;
};

export async function installedIdentity(root: string) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const versions: Record<string, string> = {};
  for (const [name, expected] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    const installed = JSON.parse(
      await readFile(
        path.join(root, "node_modules", name, "package.json"),
        "utf8",
      ),
    );
    if (installed.version !== expected)
      throw new Error(
        `Installed ${name} does not match the pinned package input`,
      );
    versions[name] = installed.version;
  }
  const lock = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
  const installedLock = await readFile(
    path.join(root, "node_modules/.pnpm/lock.yaml"),
    "utf8",
  );
  // pnpm 12 has a package-manager document followed by the application lock.
  if (
    !lock
      .split(/^---\s*$/m)
      .some((document) => document.trim() === installedLock.trim())
  )
    throw new Error(
      "Installed dependency lock does not match the frozen source lock",
    );
  const pnpm = observe("pnpm", ["--version"]);
  if (
    process.versions.node !== manifest.engines.node ||
    pnpm !== manifest.engines.pnpm
  )
    throw new Error("Preparation requires the pinned Node and pnpm toolchain");
  return {
    node: process.versions.node,
    nodeBinary: await binaryIdentity(process.execPath),
    pnpm,
    pnpmLauncher: await binaryIdentity(observe("/usr/bin/which", ["pnpm"])),
    pnpmBinary: await binaryIdentity(
      observe("pnpm", [
        "exec",
        process.execPath,
        "-p",
        "process.env.npm_execpath",
      ]),
    ),
    versions,
    dependencies: await treeDigest(
      path.join(root, "node_modules"),
      ["."],
      true,
    ),
    platform: process.platform,
    architecture: process.arch,
  };
}

export const buildEnvironmentKeys = [
  "NODE_ENV",
  "NODE_OPTIONS",
  "ELECTRON_MIRROR",
  "ELECTRON_CUSTOM_DIR",
  "ELECTRON_CUSTOM_FILENAME",
  "ELECTRON_CUSTOM_VERSION",
  "ELECTRON_GET_USE_PROXY",
  "DEVELOPER_DIR",
  "SDKROOT",
  "MACOSX_DEPLOYMENT_TARGET",
  "SWIFT_EXEC",
  "CC",
  "CXX",
  "CFLAGS",
  "CPPFLAGS",
  "LDFLAGS",
  "ARCHFLAGS",
] as const;

export async function nativeToolchainIdentity() {
  const compiler = observe("/usr/bin/xcrun", ["--find", "swiftc"]);
  return {
    compiler: await realpath(compiler),
    compilerSHA256: await binaryIdentity(compiler),
    version: observe("/usr/bin/xcrun", ["swiftc", "--version"]),
    developer: observe("/usr/bin/xcode-select", ["-p"]),
    sdk: observe("/usr/bin/xcrun", ["--show-sdk-path"]),
    sdkVersion: observe("/usr/bin/xcrun", ["--show-sdk-version"]),
    sdkBuild: observe("/usr/bin/xcrun", ["--show-sdk-build-version"]),
  };
}

export async function producerIdentity(root: string) {
  const installed = await installedIdentity(root);
  const environment = Object.fromEntries(
    buildEnvironmentKeys.map((name) => [
      name,
      process.env[name] === undefined ? null : digest(process.env[name]!),
    ]),
  );
  const identity = {
    schema: "mosey-producer-v1",
    ...installed,
    native: await nativeToolchainIdentity(),
    environment,
    viteEnvironment: digest(
      JSON.stringify(
        Object.entries(process.env)
          .filter(([name]) => name.startsWith("VITE_"))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    ),
  };
  return { ...identity, digest: digest(JSON.stringify(identity)) };
}

export async function copyPreparationInputs(
  root: string,
  destination: string,
  source: Awaited<ReturnType<typeof sourceIdentity>>,
) {
  await mkdir(destination, { recursive: true });
  for (const entry of source.entries) {
    await mkdir(path.dirname(path.join(destination, entry)), {
      recursive: true,
    });
    execFileSync(
      "/bin/cp",
      ["-cR", path.join(root, entry), path.join(destination, entry)],
      { timeout: 30000 },
    );
  }
  // Private APFS clones preserve installed bytes without sharing a mutable
  // dependency/cache directory with the originating checkout.
  execFileSync(
    "/bin/cp",
    [
      "-cR",
      path.join(root, "node_modules"),
      path.join(destination, "node_modules"),
    ],
    { timeout: 30000 },
  );
  for (const name of volatileDependencies)
    await rm(path.join(destination, "node_modules", name), {
      recursive: true,
      force: true,
    });
  if (
    (await sourceIdentity(destination)).digest !== source.digest ||
    (await sourceIdentity(root)).digest !== source.digest
  )
    throw new Error(
      "Production inputs changed while taking the preparation snapshot",
    );
}
