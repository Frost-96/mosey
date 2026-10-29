import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { build, version as viteVersion } from "vite";
import { createPackage, extractAll, getRawHeader } from "@electron/asar";
import ts from "typescript";
import type { ControlledBehaviorOptions } from "./behavior-controller";
import { measure, measureSync } from "./measurement";

const variant = "controlled-behavior-v1";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const controllerBuildOptions = {
  target: "node24",
  minify: false,
  format: "es",
};

// Legacy launchers already own their temporary root. This only prepares their
// owned dev copy; lifecycle migration belongs to the unified session tickets.
export async function copyBehaviorDevelopmentApp(root: string) {
  const directory = path.join(root, "app");
  await mkdir(directory);
  await cp("package.json", path.join(directory, "package.json"));
  await cp(".vite/build", path.join(directory, ".vite/build"), {
    recursive: true,
  });
  await cp("build/native", path.join(directory, "build/native"), {
    recursive: true,
  });
  await symlink(
    path.resolve("node_modules"),
    path.join(directory, "node_modules"),
    "dir",
  );
  return directory;
}

export async function instrumentBehaviorApplication({
  root,
  packaged,
  options = {},
  evidence = path.resolve("test-results/behavior-builds", randomUUID()),
  signal,
}: {
  root: string;
  packaged: boolean;
  options?: ControlledBehaviorOptions;
  evidence?: string;
  signal?: AbortSignal;
}) {
  return measure("behavior.derive", {}, async () => {
    const active = () => signal?.throwIfAborted();
    const ownedRoot = await realpath(root);
    if (ownedRoot === (await realpath(process.cwd())))
      throw new Error(
        "Behavior instrumentation requires an owned application copy",
      );
    const archive = path.join(root, "Mosey.app/Contents/Resources/app.asar");
    const directory = path.join(root, packaged ? "behavior-asar" : "app");
    const sourceArchive = packaged ? await readFile(archive) : undefined;
    let signature: string | undefined;
    if (packaged) {
      active();
      // Verify the genuine copied artifact before producing a labeled derivative.
      signature = measureSync("behavior.signature-verify", () =>
        execFileSync(
          "/usr/bin/codesign",
          ["--verify", "--deep", "--strict", path.join(root, "Mosey.app")],
          { timeout: 30000, encoding: "utf8", stdio: "pipe" },
        ),
      );
      measureSync("behavior.asar-extract", () =>
        extractAll(archive, directory),
      );
    }
    const manifest = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    const entry = path.resolve(directory, manifest.main);
    if (!(await realpath(entry)).startsWith(`${ownedRoot}${path.sep}`))
      throw new Error("Behavior instrumentation cannot modify a shared entry");
    const original = await readFile(entry, "utf8");
    // Forge minifies identifiers in packaged main. Match the existing session
    // environment shape, never a generated function/variable name.
    const parsed = ts.createSourceFile(
      entry,
      original,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const bootstraps: ts.ObjectLiteralExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.arguments.length === 2) {
        const environment = node.arguments[1];
        if (ts.isObjectLiteralExpression(environment)) {
          const names = environment.properties.map((property) =>
            property.name?.getText(parsed),
          );
          if (
            names.length === 4 &&
            ["dock", "refreshMenus", "publishSettings", "bodyMenu"].every(
              (name) => names.includes(name),
            )
          )
            bootstraps.push(environment);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    if (bootstraps.length !== 1)
      throw new Error(
        "Behavior instrumentation requires exactly one pet bootstrap",
      );
    const insertion = bootstraps[0].getStart(parsed) + 1;
    const inputs: Record<string, string> = {};
    for (const file of [
      "tests/support/behavior-build.ts",
      "tests/support/behavior-controller.ts",
      "src/behavior/adapters.ts",
      "pnpm-lock.yaml",
    ])
      inputs[file] = digest(await readFile(file));
    const identity = {
      variant,
      mode: packaged ? "packaged" : "development",
      parentMain: digest(original),
      parentArchive: sourceArchive ? digest(sourceArchive) : undefined,
      sources: inputs,
      options,
      controllerBuildOptions,
      viteVersion,
      nodeVersion: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
    };
    const identityHash = digest(JSON.stringify(identity));
    active();
    const built = await measure("behavior.controller-build", {}, () =>
      build({
        configFile: false,
        logLevel: "error",
        build: {
          target: controllerBuildOptions.target,
          minify: controllerBuildOptions.minify,
          write: false,
          emptyOutDir: false,
          outDir: path.dirname(entry),
          lib: {
            entry: path.resolve("tests/support/behavior-controller.ts"),
            formats: ["es"],
            fileName: () => "behavior-controller.mjs",
          },
        },
      }),
    );
    active();
    const output = Array.isArray(built) ? built[0] : built;
    if (
      !("output" in output) ||
      output.output.length !== 1 ||
      output.output[0].type !== "chunk"
    )
      throw new Error("Controlled behavior must produce one owned module");
    const controller = output.output[0].code;
    await writeFile(
      path.join(path.dirname(entry), "behavior-controller.mjs"),
      controller,
    );
    active();
    const transformed =
      `import { createBehaviorController } from "./behavior-controller.mjs";\nconst __moseyControlledBehavior = createBehaviorController(${JSON.stringify(options)});\n` +
      original.slice(0, insertion) +
      "\nbehavior: __moseyControlledBehavior.adapter," +
      original.slice(insertion);
    await writeFile(entry, transformed);
    active();
    if (packaged) {
      await measure("behavior.asar-repack", {}, () =>
        createPackage(directory, archive),
      );
      active();
      // The signed derivative must describe its own ASAR header, not the original.
      const headerHash = digest(getRawHeader(archive).headerString);
      measureSync("behavior.integrity", () =>
        execFileSync(
          "/usr/libexec/PlistBuddy",
          [
            "-c",
            `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}`,
            path.join(root, "Mosey.app/Contents/Info.plist"),
          ],
          { timeout: 5000 },
        ),
      );
      measureSync("behavior.sign", () =>
        execFileSync(
          "/usr/bin/codesign",
          ["--force", "--deep", "--sign", "-", path.join(root, "Mosey.app")],
          { timeout: 30000, stdio: "pipe" },
        ),
      );
      await rm(directory, { recursive: true, force: true });
    }
    active();
    const receipt = {
      ...identity,
      identity: identityHash,
      root: ownedRoot,
      signatureVerification: packaged
        ? { passed: true, output: signature }
        : undefined,
      outputs: {
        main: digest(transformed),
        controller: digest(controller),
        archive: packaged ? digest(await readFile(archive)) : undefined,
      },
    };
    await mkdir(evidence, { recursive: true });
    await writeFile(
      path.join(evidence, "behavior-build.json"),
      JSON.stringify(receipt, null, 2),
    );
    console.log(
      `[behavior-build] ${JSON.stringify({ variant, identity: identityHash, mode: identity.mode, evidence })}`,
    );
    return receipt;
  });
}
