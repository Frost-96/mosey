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
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        if (!server?.pid) return;
        const child = server;
        const signal = (value: NodeJS.Signals) => {
          try {
            process.kill(-child.pid!, value);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        };
        const exited = new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", () => resolve());
        });
        // Only this launch's detached group is ours. Escalate if Forge or its
        // shim ignores TERM, including when startup never reached readiness.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const forced = new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => {
            try {
              signal("SIGKILL");
              resolve();
            } catch (error) {
              reject(error);
            }
          }, 5000);
        });
        try {
          signal("SIGTERM");
          await Promise.race([exited, forced]);
          signal("SIGKILL");
          await exited;
        } finally {
          clearTimeout(timer);
        }
      } finally {
        await rm(shim, { recursive: true, force: true });
      }
    })());
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
    let spawnError: Error | undefined;
    server.on("error", (error) => {
      spawnError = error;
    });
    server.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    server.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    await expect
      .poll(
        () => {
          if (spawnError) throw spawnError;
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
