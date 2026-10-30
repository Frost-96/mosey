import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function observationError(error: unknown): unknown {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(error.cause === undefined
          ? {}
          : { cause: observationError(error.cause) }),
        ...(error instanceof AggregateError
          ? { errors: error.errors.map(observationError) }
          : {}),
      }
    : String(error);
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function bounded<T>(
  label: string,
  action: () => Promise<T>,
  timeout: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label} did not complete within ${timeout}ms`)),
          timeout,
        );
        if (signal) {
          aborted = () => reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (aborted) signal?.removeEventListener("abort", aborted);
  }
}

export const captureObservationEvidence = <T>(action: () => Promise<T>) =>
  bounded("observation-evidence", action, 5000);

// Manual macOS observations must keep the supplied signed bundle path,
// permission identity and native scale. The test session's copied/re-signed,
// forced-DPR fixture would change that premise. This owner never writes the
// bundle: it owns only one acquisition, its temporary profile and its processes.
export async function createObservationSession({
  bundle,
  evidence,
  inheritEnvironment = false,
  signal,
}: {
  bundle: string;
  evidence: string;
  inheritEnvironment?: boolean;
  signal?: AbortSignal;
}) {
  signal?.throwIfAborted();
  bundle = path.resolve(bundle);
  evidence = path.resolve(evidence);
  await mkdir(evidence, { recursive: true });
  const profile = await mkdtemp(path.join(os.tmpdir(), "mosey-observation-"));
  let app: ElectronApplication | undefined;
  let child: ChildProcess | undefined;
  let stage = "created";
  let failure: unknown;
  let closing: Promise<void> | undefined;
  let cancelled = false;
  let launched = false;
  const cancellation = new AbortController();
  let acquisition: Promise<ElectronApplication> | undefined;
  let rootStart: string | undefined;
  let bytes = 0;
  let truncated = false;
  const record = (event: string, detail?: unknown, critical = true) => {
    const line =
      JSON.stringify({
        event,
        stage,
        at: new Date().toISOString(),
        bundle,
        profile,
        pid: child?.pid,
        exitCode: child?.exitCode,
        signal: child?.signalCode,
        detail,
      }) + "\n";
    if (!critical && bytes + Buffer.byteLength(line) > 1024 * 1024) {
      if (!truncated) {
        truncated = true;
        appendFileSync(
          path.join(evidence, "lifecycle.jsonl"),
          JSON.stringify({ event: "operation-trace-limit" }) + "\n",
        );
      }
      return;
    }
    bytes += Buffer.byteLength(line);
    appendFileSync(path.join(evidence, "lifecycle.jsonl"), line);
  };
  const active = () => {
    if (cancelled)
      throw new Error("Observation session is closed or cancelled", {
        cause: failure,
      });
  };
  const fail = (error: unknown) => {
    if (failure === undefined) {
      failure = error;
      record("first-failure", observationError(error));
    }
    cancelled = true;
    cancellation.abort(error);
  };
  const processes = () =>
    execFileSync("/bin/ps", ["-axo", "pid=,pgid=,lstart=,state=,comm="], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, LC_ALL: "C" },
    })
      .trim()
      .split("\n")
      .map((line) => {
        const fields = line.trim().split(/\s+/);
        return {
          pid: Number(fields[0]),
          group: Number(fields[1]),
          start: fields.slice(2, 7).join(" "),
          state: fields[7]!,
          command: fields.slice(8).join(" "),
        };
      });
  const group = () => {
    const rows = processes();
    const current = rows.find((row) => row.pid === child?.pid);
    if (current && rootStart && current.start !== rootStart)
      throw new Error(
        "Owned observation PID was reused; refusing to signal another process",
      );
    return rows.filter(
      (row) => row.group === child?.pid && !row.state.startsWith("Z"),
    );
  };
  const exited = () =>
    child !== undefined &&
    (child.exitCode !== null || child.signalCode !== null);
  const stop = async () => {
    if (!child?.pid) return;
    record("safety-cleanup");
    if (!exited()) {
      await bounded(
        "driver-close",
        () =>
          Promise.race([
            app!.close(),
            new Promise<void>((resolve) =>
              child!.once("exit", () => resolve()),
            ),
          ]),
        5000,
      ).catch((error) =>
        record("driver-close-failed", observationError(error)),
      );
    }
    let permission: unknown;
    if (group().length) {
      record("safety-signal", "SIGKILL");
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM") {
          permission = error;
          record("group-signal-partial", observationError(error));
        } else if (code !== "ESRCH") throw error;
      }
    }
    const deadline = performance.now() + 5000;
    let live = group();
    while ((!exited() || live.length) && performance.now() < deadline) {
      await pause(25);
      live = group();
    }
    record("owned-processes", { exited: exited(), live });
    if (!exited() || live.length) {
      const survivor = new Error(
        `Owned observation processes survived cleanup: ${JSON.stringify(live)}`,
      );
      throw permission
        ? new AggregateError(
            [permission, survivor],
            "Permission-denied observation cleanup",
            { cause: survivor },
          )
        : survivor;
    }
  };
  const close = () =>
    (closing ??= (async () => {
      cancelled = true;
      cancellation.abort(failure ?? new Error("Observation session closed"));
      try {
        await stop();
        if (acquisition) {
          await bounded(
            "owned-launch-settlement",
            () =>
              acquisition!.then(
                () => {},
                () => {},
              ),
            10000,
          );
          // A late adoption may itself fail to stop. Verify that actual process
          // again; swallowing its rejected promise must not hide a survivor.
          await stop();
        }
        await rm(profile, { recursive: true, force: true });
        signal?.removeEventListener("abort", cancel);
        record("cleanup-complete", { live: [], profileRemoved: true });
      } catch (error) {
        record("cleanup-failed", observationError(error));
        closing = undefined;
        throw error;
      }
    })());
  const finishFailure = async (error: unknown): Promise<never> => {
    fail(error);
    const cleanup = await close().then(
      () => undefined,
      (failure: unknown) => ({ failure }),
    );
    if (cleanup)
      throw new AggregateError(
        [error, cleanup.failure],
        "Observation and cleanup failed",
        { cause: error },
      );
    throw error;
  };
  const run = async <T>(
    label: string,
    action: () => Promise<T>,
    { timeout = 5000 } = {},
  ): Promise<T> => {
    active();
    stage = label;
    record("operation", undefined, false);
    try {
      const value = await bounded(
        label,
        () => {
          active();
          return action();
        },
        timeout,
        cancellation.signal,
      );
      active();
      return value;
    } catch (error) {
      return finishFailure(error);
    }
  };
  const cancel = () => {
    fail(new Error("Observation session cancelled", { cause: signal?.reason }));
    void close().catch((error: unknown) =>
      record("cancellation-cleanup-failed", observationError(error)),
    );
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    cancel();
    await close();
    throw failure;
  }
  return {
    profile,
    evidence,
    run,
    close,
    async launch() {
      active();
      if (launched) throw new Error("Observation session has already launched");
      launched = true;
      const executablePath = await run("original-executable", async () => {
        const name = execFileSync(
          "/usr/libexec/PlistBuddy",
          [
            "-c",
            "Print :CFBundleExecutable",
            path.join(bundle, "Contents/Info.plist"),
          ],
          { encoding: "utf8", timeout: 5000 },
        ).trim();
        if (
          !name ||
          name === "." ||
          name === ".." ||
          path.basename(name) !== name ||
          name.includes("\\") ||
          [...name].some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
          })
        ) {
          throw new Error(
            "CFBundleExecutable must be a single executable filename",
          );
        }
        return path.join(bundle, "Contents/MacOS", name);
      });
      acquisition = Promise.resolve()
        .then(() => {
          active();
          return electron.launch({
            executablePath,
            args: [`--user-data-dir=${profile}`],
            timeout: 30000,
            ...(inheritEnvironment
              ? {}
              : {
                  cwd: profile,
                  env: {
                    HOME: os.homedir(),
                    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
                    TMPDIR: os.tmpdir(),
                  },
                }),
          });
        })
        .then(async (acquired) => {
          app = acquired;
          child = acquired.process();
          rootStart = processes().find((row) => row.pid === child!.pid)?.start;
          child.once("exit", () => record("app-exited"));
          record("app-acquired");
          if (cancelled) {
            await stop();
            throw new Error(
              "Observation session cancelled during acquisition",
              { cause: failure },
            );
          }
          return acquired;
        });
      const current = await run("launch", () => acquisition!, {
        timeout: 30000,
      });
      const pet = await run(
        "initial-window",
        () => app!.firstWindow({ timeout: 15000 }),
        { timeout: 15000 },
      );
      const runtime = await run("runtime", () =>
        app!.evaluate(({ app, screen }) => ({
          userData: app.getPath("userData"),
          executable: process.execPath,
          displays: screen
            .getAllDisplays()
            .map(({ id, scaleFactor }) => ({ id, scaleFactor })),
        })),
      );
      if ((await realpath(runtime.userData)) !== (await realpath(profile)))
        return finishFailure(
          new Error("Temporary profile isolation was not applied"),
        );
      const dpr = await run("unforced-dpr", () =>
        pet.evaluate(() => devicePixelRatio),
      );
      record("ready", {
        ...runtime,
        dpr,
        scaleCoverage: "unforced observation; no requested 1x/2x coverage",
      });
      return { app: current, pet, child: child! };
    },
    async quit() {
      active();
      if (!app || !child)
        throw new Error("Observation session has no application");
      stage = "normal-exit";
      const owned = child;
      if (exited())
        return finishFailure(
          new Error(
            "normal-exit failed: application already exited before Quit",
          ),
        );
      void Promise.resolve()
        .then(() => {
          active();
          return app!.evaluate(({ Menu }) => {
            const item = Menu.getApplicationMenu()
              ?.items.find((item) => item.label === "Mosey")
              ?.submenu?.items.find((item) => item.label === "Quit Mosey");
            if (!item) throw new Error("Missing Quit Mosey menu item");
            setImmediate(() => item.click());
          });
        })
        .then(
          () => record("quit-acknowledged"),
          (error) =>
            record("quit-acknowledgement-failed", observationError(error)),
        );
      try {
        await bounded(
          "normal-exit",
          () =>
            new Promise<void>((resolve, reject) => {
              const completed = () =>
                owned.exitCode === 0 && owned.signalCode === null
                  ? resolve()
                  : reject(
                      new Error(
                        `normal-exit failed: code=${owned.exitCode}, signal=${owned.signalCode}`,
                      ),
                    );
              if (exited()) completed();
              else owned.once("exit", completed);
            }),
          10000,
          cancellation.signal,
        );
        active();
        record("normal-exit-complete");
        await close();
        return {
          exitCode: owned.exitCode,
          signal: owned.signalCode,
          remainingPids: [] as number[],
        };
      } catch (error) {
        return finishFailure(error);
      }
    },
  };
}
