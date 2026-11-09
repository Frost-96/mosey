import { evidencePath } from "./evidence";
import { inject } from "vitest";
import { appendFile } from "node:fs/promises";
import {
  launchForgeServer,
  verifyNativeRuntime,
} from "../../tools/forge-server.ts";

declare module "vitest" {
  export interface ProvidedContext {
    forgeServer?:
      | { pid: number; directory: string; nativeRuntime: string }
      | { error: string };
  }
}

export async function startForge(): Promise<() => Promise<void>> {
  const shared = inject("forgeServer");
  if (shared) {
    if ("error" in shared) throw new Error(shared.error);
    if (shared.directory !== process.cwd())
      throw new Error("Shared Forge server belongs to another checkout");
    // The run owns the server; each test still owns its Electron processes,
    // profile and substituted native producer. Never silently restart a dead
    // shared server, which would hide a failed development lifecycle.
    process.kill(shared.pid, 0);
    // Legacy fixtures temporarily replace this binary in the checkout. A
    // shared server must not pass their leftover producer to the next app.
    await verifyNativeRuntime(shared.nativeRuntime);
    return async () => {};
  }
  const server = await launchForgeServer();
  try {
    await appendFile(
      evidencePath("forge-preparation.jsonl"),
      JSON.stringify({ seconds: server.seconds }) + "\n",
    );
    return server.stop;
  } catch (error) {
    await server.stop();
    throw error;
  }
}
