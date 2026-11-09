import { mkdir, writeFile } from "node:fs/promises";
import type { TestProject } from "vitest/node";
import {
  launchForgeServer,
  nativeRuntimeIdentity,
  verifyNativeRuntime,
} from "../../tools/forge-server.ts";

export default async function setup(project: TestProject) {
  if (
    !project.vitest.projects.some((entry) =>
      entry.name.startsWith("development"),
    )
  )
    return;
  await mkdir("test-results", { recursive: true });
  let server: Awaited<ReturnType<typeof launchForgeServer>>;
  try {
    server = await launchForgeServer();
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    await writeFile("test-results/ci-forge.log", message);
    // A development preparation failure must not suppress packaged validation.
    // Each development fixture reports the original error; no retry can hide it.
    project.provide("forgeServer", { error: message });
    return;
  }
  let nativeRuntime: string;
  try {
    nativeRuntime = await nativeRuntimeIdentity();
    await writeFile(
      "test-results/ci-forge-preparation.json",
      JSON.stringify({ launches: 1, seconds: server.seconds }, null, 2),
    );
    project.provide("forgeServer", {
      pid: server.pid,
      directory: process.cwd(),
      nativeRuntime,
    });
  } catch (error) {
    await server.stop();
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    await writeFile("test-results/ci-forge.log", message);
    project.provide("forgeServer", { error: message });
    return;
  }
  return async () => {
    try {
      // A crashed server must fail the run even if its last test already passed.
      server.assertRunning();
      await verifyNativeRuntime(nativeRuntime);
    } finally {
      try {
        await writeFile("test-results/ci-forge.log", server.output());
      } finally {
        await server.stop();
      }
    }
  };
}
