import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beginMeasurement, measure, recordMeasurement } from "./measurement";
import {
  isLiveProcess,
  readProcessSnapshot,
  sameProcess,
  signalProcessGroup,
  type MacOSProcess,
} from "../../tools/macos-processes";

// Let Forge prepare the real dev build/server without launching an unmanaged
// app. Each caller owns one cleanup function, including on readiness failure.
export async function startForge({
  signal,
  cwd = process.cwd(),
  preparationId,
  registerStop,
}: {
  signal?: AbortSignal;
  cwd?: string;
  preparationId?: string;
  registerStop?: (stop: () => Promise<void>) => void;
} = {}): Promise<() => Promise<void>> {
  const finishPreparation = beginMeasurement("forge.prepare");
  const shim = await mkdtemp(path.join(os.tmpdir(), "mosey-forge-"));
  const executable = path.join(shim, "Electron.app/Contents/MacOS/Electron");
  let server: ReturnType<typeof spawn> | undefined;
  const known = new Map<number, MacOSProcess>();
  // pnpm's script shells and Swift frontends create their own process groups.
  // Retain observed ancestry across reparenting instead of equating one PGID
  // with the whole preparation. Start time guards against PID reuse.
  const observe = () => {
    const rows = readProcessSnapshot();
    const owned = new Set(
      rows
        .filter((row) => sameProcess(known.get(row.pid), row))
        .map((row) => row.pid),
    );
    if (
      server?.pid &&
      server.exitCode === null &&
      server.signalCode === null &&
      !known.has(server.pid)
    )
      owned.add(server.pid);
    let changed = true;
    while (changed) {
      changed = false;
      const groups = new Set(
        rows.filter((row) => owned.has(row.pid)).map((row) => row.group),
      );
      for (const row of rows)
        if (
          (owned.has(row.parent) || groups.has(row.group)) &&
          !owned.has(row.pid)
        ) {
          owned.add(row.pid);
          changed = true;
        }
    }
    const members = rows.filter((row) => owned.has(row.pid));
    for (const member of members) known.set(member.pid, member);
    return members.filter(isLiveProcess);
  };
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= measure("forge.release", { preparationId }, async () => {
      if (server?.pid) {
        const child = server;
        const signalled = new Map<NodeJS.Signals, Set<number>>();
        const signalMembers = (value: NodeJS.Signals) => {
          const members = observe();
          recordMeasurement("forge-owned-processes", {
            preparationId,
            signal: value,
            members,
          });
          const groups = signalled.get(value) ?? new Set<number>();
          signalled.set(value, groups);
          for (const group of new Set(members.map((member) => member.group))) {
            if (groups.has(group)) continue;
            if (
              signalProcessGroup(
                members.filter((member) => member.group === group),
                value,
              )
            )
              groups.add(group);
          }
        };
        const exited = new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", () => resolve());
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          signalMembers("SIGTERM");
          await Promise.race([
            exited,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 5000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        signalMembers("SIGKILL");
        const deadline = performance.now() + 5000;
        let remaining = observe();
        while (remaining.length && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          signalMembers("SIGKILL");
          remaining = observe();
        }
        if (remaining.length)
          throw new Error(
            `Owned Forge descendants survived cleanup: ${JSON.stringify(remaining)}`,
          );
        await exited;
        recordMeasurement("forge-processes-reaped", {
          preparationId,
          pids: [...known.keys()],
        });
      }
      // A failed reap retains files for diagnostics instead of racing a writer.
      await rm(shim, { recursive: true, force: true });
    }));
  registerStop?.(stop);
  try {
    signal?.throwIfAborted();
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(
      executable,
      "#!/bin/sh\necho MOSEY_TEST_READY\nexec /bin/cat\n",
    );
    await chmod(executable, 0o755);
    signal?.throwIfAborted();
    server = spawn("pnpm", ["start"], {
      cwd,
      env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: shim },
      stdio: "pipe",
      detached: true,
    });
    recordMeasurement("forge-process", {
      processId: server.pid,
      groupId: server.pid,
    });
    let output = "";
    let aborted: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observation: ReturnType<typeof setInterval> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        observe();
        observation = setInterval(() => {
          try {
            observe();
          } catch (error) {
            reject(error);
          }
        }, 250);
        const capture = (data: Buffer) => {
          output = (output + data.toString()).slice(-32768);
          if (output.includes("MOSEY_TEST_READY")) resolve();
        };
        server!.stdout?.on("data", capture);
        server!.stderr?.on("data", capture);
        server!.once("error", reject);
        server!.once("exit", (code, exitSignal) =>
          reject(
            new Error(
              `Forge exited before readiness: ${code}/${exitSignal}\n${output}`,
            ),
          ),
        );
        timer = setTimeout(
          () =>
            reject(new Error(`Forge preparation exceeded 60000ms\n${output}`)),
          60000,
        );
        aborted = () => reject(signal?.reason);
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
      });
    } finally {
      clearTimeout(timer);
      clearInterval(observation);
      if (aborted) signal?.removeEventListener("abort", aborted);
    }
    finishPreparation("passed");
    return stop;
  } catch (error) {
    finishPreparation(signal?.aborted ? "cancelled" : "failed", error);
    const cleanup = await stop().then(
      () => undefined,
      (failure: unknown) => ({ failure }),
    );
    if (cleanup)
      throw new AggregateError(
        [error, cleanup.failure],
        "Forge preparation and cleanup failed",
        { cause: error },
      );
    throw error;
  }
}
