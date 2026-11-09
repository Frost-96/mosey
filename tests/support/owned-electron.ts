import { execFileSync, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { ElectronApplication } from "playwright";

export const ownedProcessGroup = (pid: number) =>
  execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,uid=,state=,comm="], {
    timeout: 5000,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => Number(line.trim().split(/\s+/)[2]) === pid);

// Playwright starts Electron in its own process group. Keep the acquired OS
// handle: its accessor may disappear after a crash or an explicit quit.
export async function closeOwnedElectron(
  application: Pick<ElectronApplication, "close">,
  child: ChildProcess,
  {
    graceMs = 5000,
    partialSignal,
  }: { graceMs?: number; partialSignal?: (group: string[]) => void } = {},
) {
  if (!child.pid) throw new Error("Owned Electron process has no PID");
  const pid = child.pid;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const live = () =>
    ownedProcessGroup(pid).filter(
      (line) => !line.trim().split(/\s+/)[4]!.startsWith("Z"),
    );
  const signal = () => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") partialSignal?.(ownedProcessGroup(pid));
      else if (code !== "ESRCH") throw error;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExit: (() => void) | undefined;
  let forced = false;
  let closeError: unknown;
  try {
    if (!exited())
      await Promise.race([
        application.close().catch((error: unknown) => {
          closeError = error;
        }),
        new Promise<void>((resolve) => {
          onExit = resolve;
          child.once("exit", resolve);
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            forced = true;
            resolve();
          }, graceMs);
        }),
      ]);
  } finally {
    clearTimeout(timer);
    if (onExit) child.off("exit", onExit);
    // Reap helpers even when the leader already exited or close() rejected.
    try {
      forced ||= !exited() || live().length > 0;
    } finally {
      signal();
    }
  }
  const deadline = performance.now() + 5000;
  while (!exited() || live().length) {
    if (performance.now() >= deadline)
      throw new Error(`Owned Electron process group ${pid} did not exit`, {
        cause: closeError,
      });
    await delay(25);
  }
  if (closeError) throw closeError;
  return { forced };
}
