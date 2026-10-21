import { expect } from "vitest";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Let Forge prepare the real dev build/server without launching an unmanaged
// app. Each caller owns one cleanup function, including on readiness failure.
export async function startForge(): Promise<() => Promise<void>> {
  const shim = await mkdtemp(path.join(os.tmpdir(), "mosey-forge-"));
  const executable = path.join(shim, "Electron.app/Contents/MacOS/Electron");
  let server: ReturnType<typeof spawn> | undefined;
  const stop = async () => {
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
      if (server.exitCode === null && server.signalCode === null)
        await new Promise<void>((resolve) =>
          server!.once("exit", () => resolve()),
        );
    }
    await rm(shim, { recursive: true, force: true });
  };
  try {
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(
      executable,
      "#!/bin/sh\necho MOSEY_TEST_READY\nexec /bin/cat\n",
    );
    await chmod(executable, 0o755);
    server = spawn("pnpm", ["start"], {
      env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: shim },
      stdio: "pipe",
      detached: true,
    });
    let output = "";
    server.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    server.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    await expect
      .poll(
        () => {
          if (server?.exitCode !== null || server.signalCode !== null)
            throw new Error(output);
          return output;
        },
        { timeout: 60000 },
      )
      .toContain("MOSEY_TEST_READY");
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}
