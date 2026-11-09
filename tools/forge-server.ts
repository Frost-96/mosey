import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function nativeRuntimeIdentity() {
  const file = "build/native/dock-runtime";
  const [bytes, metadata] = await Promise.all([readFile(file), stat(file)]);
  return createHash("sha256")
    .update(String(metadata.mode & 0o777))
    .update(bytes)
    .digest("hex");
}

export async function verifyNativeRuntime(expected: string) {
  if ((await nativeRuntimeIdentity()) !== expected)
    throw new Error("A development fixture did not restore the native runtime");
}

// Forge builds the real development entry points and serves the renderer.
// Only its unmanaged Electron launch is replaced; tests own their actual apps.
export async function launchForgeServer({
  command = "pnpm",
  args = ["start"],
  timeoutMs = 60000,
}: { command?: string; args?: string[]; timeoutMs?: number } = {}) {
  const started = performance.now();
  const shim = await mkdtemp(path.join(os.tmpdir(), "mosey-forge-"));
  const executable = path.join(shim, "Electron.app/Contents/MacOS/Electron");
  let server: ReturnType<typeof spawn> | undefined;
  let stopping: Promise<void> | undefined;
  let output = "";
  let spawnError: Error | undefined;
  const assertRunning = () => {
    if (spawnError) throw spawnError;
    if (!server || server.exitCode !== null || server.signalCode !== null)
      throw new Error(
        `Forge server exited before its owner finished:\n${output}`,
      );
  };
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
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          signal("SIGTERM");
          await Promise.race([
            exited,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 5000);
            }),
          ]);
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
    server = spawn(command, args, {
      env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: shim },
      stdio: "pipe",
      detached: true,
    });
    server.on("error", (error) => {
      spawnError = error;
    });
    const collect = (data: Buffer) => {
      output = (output + data.toString()).slice(-128 * 1024);
    };
    server.stdout?.on("data", collect);
    server.stderr?.on("data", collect);
    while (!output.includes("MOSEY_TEST_READY")) {
      assertRunning();
      if (performance.now() - started >= timeoutMs)
        throw new Error(`Forge startup exceeded ${timeoutMs}ms:\n${output}`);
      await delay(25);
    }
    assertRunning();
    return {
      pid: server.pid!,
      seconds: (performance.now() - started) / 1000,
      output: () => output,
      assertRunning,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
