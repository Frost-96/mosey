import { expect } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { createPetTestSession } from "./pet-session";
import {
  liveProcessGroup,
  readProcessSnapshot,
  readProcessSnapshotAsync,
  signalProcessGroup,
  type ProcessIdentity,
} from "../../tools/macos-processes";

const execute = promisify(execFile);

// The ordinary inspector launch cannot prove the shipped no-inspector entry
// point. Reuse its owned package/profile, cancellation guard and pre-registered
// platform compensation; only the uninstrumented process adapter differs.
// This verifies product startup and safety cleanup, with no renderer DPR claim.
export async function createPackagedStartupSession({
  signal,
}: { signal?: AbortSignal } = {}) {
  let bundle = "";
  let evidence = "";
  let child: ChildProcess | undefined;
  let identity: ProcessIdentity | undefined;
  let spawnError: Error | undefined;
  let output = "";
  let rendererObserved = false;
  const record = (event: string, detail?: unknown) =>
    appendFileSync(
      path.join(evidence, "startup.jsonl"),
      JSON.stringify({
        event,
        pid: child?.pid,
        group: child?.pid,
        code: child?.exitCode,
        signal: child?.signalCode,
        detail,
      }) + "\n",
    );
  const session = await createPetTestSession({
    dock: "real",
    signal,
    packagedPlatform: {
      async prepare(context) {
        bundle = context.bundle;
        evidence = context.evidence;
      },
      async restore({ run }) {
        const owned = child;
        if (!owned?.pid) return;
        let permissionError: unknown;
        const signalGroup = async (value: NodeJS.Signals) => {
          record("startup-safety-signal", value);
          try {
            signalProcessGroup(
              liveProcessGroup(await processes(), owned.pid!, identity),
              value,
            );
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EPERM") {
              permissionError = error;
              record("startup-signal-partial", { value, code });
            } else if (code !== "ESRCH") throw error;
          }
        };
        await run("startup-safety-term", () => signalGroup("SIGTERM"));
        await run(
          "startup-safety-exit",
          () =>
            new Promise<void>((resolve) => {
              if (owned.exitCode !== null || owned.signalCode !== null)
                return resolve();
              const finished = () => {
                clearTimeout(timer);
                owned.off("exit", finished);
                resolve();
              };
              const timer = setTimeout(finished, 3000);
              owned.once("exit", finished);
            }),
          { timeout: 3500 },
        );
        // Reap the owned group even when the leader exited before a helper.
        // Safety termination is deliberately separate from ordinary menu Quit.
        await run("startup-safety-kill", () => signalGroup("SIGKILL"));
        try {
          await expect
            .poll(
              async () => {
                const rows = await run("startup-owned-group", processes);
                const live = liveProcessGroup(rows, owned.pid!, identity);
                record("startup-cleanup-observation", { live });
                return {
                  exited: owned.exitCode !== null || owned.signalCode !== null,
                  live,
                };
              },
              { timeout: 3000 },
            )
            .toEqual({ exited: true, live: [] });
        } catch (error) {
          if (permissionError)
            throw new AggregateError(
              [permissionError, error],
              "Uninstrumented startup group survived permission-denied cleanup",
              { cause: error },
            );
          throw error;
        }
        record("startup-safety-cleanup-complete", { normalExitClaim: false });
      },
    },
  });
  const processes = readProcessSnapshotAsync;
  return {
    close: session.close,
    evidence: session.evidence,
    profile: session.profile,
    output: () => output,
    async minimumSystemVersion() {
      const { stdout } = await session.run("startup-minimum-system", () =>
        execute(
          "/usr/libexec/PlistBuddy",
          [
            "-c",
            "Print :LSMinimumSystemVersion",
            path.join(bundle, "Contents/Info.plist"),
          ],
          { encoding: "utf8", timeout: 5000 },
        ),
      );
      return stdout.trim();
    },
    launch: () =>
      session.run("startup-launch", async () => {
        if (child) throw new Error("Uninstrumented startup already launched");
        // Spawn assigns the owned handle synchronously, before the guarded
        // acquisition resolves. Cancellation cannot orphan a late return value.
        child = spawn(
          process.env.MOSEY_STARTUP_EXECUTABLE ??
            path.join(bundle, "Contents/MacOS/Mosey"),
          [`--user-data-dir=${session.profile}`],
          {
            env: {
              HOME: os.homedir(),
              PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
              TMPDIR: os.tmpdir(),
            },
            cwd: "/",
            stdio: "pipe",
            detached: true,
          },
        );
        identity = readProcessSnapshot().find((row) => row.pid === child!.pid);
        record("startup-acquired");
        child.once("error", (error) => {
          spawnError = error;
          record("startup-error", String(error));
        });
        child.once("exit", () => record("startup-exited"));
        const capture = (data: Buffer) => {
          output = (output + data.toString()).slice(-1024 * 1024);
          appendFileSync(path.join(evidence, "startup-output.txt"), data);
        };
        child.stdout?.on("data", capture);
        child.stderr?.on("data", capture);
        return child;
      }),
    async hasRenderer() {
      return session.run("startup-renderer", async () => {
        if (spawnError) throw spawnError;
        if (!child || child.exitCode !== null || child.signalCode !== null)
          throw new Error(`App exited before renderer startup: ${output}`);
        const observed = (await processes()).some(
          (row) =>
            row.parent === child!.pid &&
            row.group === child!.pid &&
            row.command.includes("--type=renderer"),
        );
        if (observed && !rendererObserved) {
          rendererObserved = true;
          record("startup-renderer-observed", {
            scaleCoverage: "independent; no renderer DPR observed",
          });
        }
        return observed;
      });
    },
  };
}
