import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

export async function preparationSourceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-input-fixture-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const name of [
    "src",
    "native",
    "tools",
    "node_modules",
    "tests/support",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "forge.config.ts",
    "vite.main.config.ts",
    "vite.preload.config.ts",
    "vite.renderer.config.ts",
    "tsconfig.json",
    "index.html",
    ".node-version",
    ".nvmrc",
  ]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    execFileSync(
      "/bin/cp",
      ["-cR", path.resolve(name), path.join(root, name)],
      { timeout: 30000 },
    );
  }
  return root;
}
