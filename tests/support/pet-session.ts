import { expect, onTestFinished } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DockObservation } from "../../src/main/platform/dock/runtime-protocol";
import { startForge } from "./forge";
import { instrumentBehaviorApplication } from "./behavior-build";
import type { ControlledBehaviorOptions } from "./behavior-controller";
import { observePetRenderer } from "./pet-renderer";
import { nativeArtifactInventory, type DockProducer } from "./dock-producer";

export type SessionOperation = <T>(
  label: string,
  action: () => Promise<T>,
  options?: { timeout?: number },
) => Promise<T>;

export type PackagedPlatformOwnership = {
  prepare?(context: {
    bundle: string;
    evidence: string;
    signal: AbortSignal;
    run: SessionOperation;
  }): Promise<void>;
  // Some OS resources can only be restored by their still-live app identity.
  // This compensation must never launch an app or resume scenario operations.
  restore(context: {
    app: ElectronApplication | undefined;
    attemptedLaunch: boolean;
    run: SessionOperation;
  }): Promise<void>;
  release?(context: { run: SessionOperation }): Promise<void>;
};

type SessionOptions = {
  behavior?: ControlledBehaviorOptions;
  signal?: AbortSignal;
  preferences?: unknown;
  // Destructive main-process faults must not share macOS restoration history.
  isolateAppIdentity?: boolean;
  packagedPlatform?: PackagedPlatformOwnership;
  // Synthetic inputs prove application behavior at the native wire boundary,
  // never real Dock capture, permission, focus or cross-application input.
  dock: "real" | "empty" | "controlled" | DockProducer;
  scaleFactor?: string;
  recordVideo?: {
    dir: string;
    size: { width: number; height: number };
    fps: number;
  };
};

const processGroup = (pid: number) =>
  execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,uid=,state=,comm="], {
    timeout: 5000,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => Number(line.trim().split(/\s+/)[2]) === pid);

// A session owns its profile, launcher, substituted capture producer and every
// app it launches. Cleanup is registered before acquisition and unwinds in
// reverse order, continuing even when one release fails. Test exit is a safety
// net; close() also permits several independent profiles in a single scenario.
export async function createPetTestSession(options: SessionOptions) {
  const evidence = path.resolve(
    "test-results/pet-sessions",
    `${process.env.MOSEY_TEST_MODE}-${randomUUID()}`,
  );
  mkdirSync(evidence, { recursive: true });
  const started = performance.now();
  const testName = expect.getState().currentTestName;
  const requestedScale = Number(
    options.scaleFactor ?? process.env.MOSEY_TEST_SCALE_FACTOR ?? "1",
  );
  let stage = "preparing";
  let root: string | undefined;
  let app: ElectronApplication | undefined;
  let appProcess: ReturnType<ElectronApplication["process"]> | undefined;
  let attemptedLaunch = false;
  const processes: ReturnType<ElectronApplication["process"]>[] = [];
  const record = (event: string, detail?: unknown) => {
    appendFileSync(
      path.join(evidence, "progress.jsonl"),
      JSON.stringify({
        event,
        stage,
        mode: process.env.MOSEY_TEST_MODE,
        requestedScale,
        elapsed: performance.now() - started,
        test: testName,
        root,
        detail,
        processes: processes.map((child) => ({
          pid: child.pid,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        })),
      }) + "\n",
    );
  };
  const mark = (value: string) => {
    stage = value;
    record("stage");
  };
  const releases: (() => Promise<void>)[] = [];
  let platformRestoration: Promise<void> | undefined;
  let platformArmed = false;
  let retainRoot = false;
  let closing: Promise<void> | undefined;
  const cancellation = new AbortController();
  let firstFailure: unknown;
  const active = () => {
    if (closing || cancellation.signal.aborted)
      throw new Error("Pet session is closed or cancelled", {
        cause: firstFailure,
      });
  };
  const fail = (error: unknown) => {
    if (firstFailure === undefined) {
      firstFailure = error;
      record(
        "first-failure",
        error instanceof Error ? error.stack : String(error),
      );
    }
    cancellation.abort(error);
  };
  const step = async <T>(
    label: string,
    action: () => Promise<T>,
    timeout = 5000,
  ): Promise<T> => {
    active();
    mark(label);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(cancellation.signal.reason);
        cancellation.signal.addEventListener("abort", aborted, { once: true });
        timer = setTimeout(
          () =>
            fail(new Error(`${label} did not complete within ${timeout}ms`)),
          timeout,
        );
      });
      const result = await Promise.race([action(), cancelled]);
      active();
      return result;
    } finally {
      clearTimeout(timer);
      if (aborted) cancellation.signal.removeEventListener("abort", aborted);
    }
  };
  let pending: Promise<unknown> = Promise.resolve();
  const acquisitions = new Set<Promise<unknown>>();
  const settleOwnership = async (work: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Owned acquisition did not settle within 10000ms during cleanup",
                ),
              ),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const platformCleanup = async (
    label: string,
    action: (run: SessionOperation) => Promise<void>,
  ) => {
    // Cleanup has its own narrow guard: scenario cancellation permits OS
    // restoration, but a restoration deadline forbids later continuations.
    let available = true;
    const run: SessionOperation = async (
      label,
      action,
      { timeout = 5000 } = {},
    ) => {
      if (!available)
        throw new Error("Platform restoration is no longer active");
      mark(label);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          action(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              available = false;
              reject(
                new Error(`${label} did not complete within ${timeout}ms`),
              );
            }, timeout);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await run(label, () => action(run), { timeout: 10000 });
    } finally {
      available = false;
    }
  };
  const restorePlatform = () => {
    const platform = options.packagedPlatform;
    if (!platform || !platformArmed) return Promise.resolve();
    return (platformRestoration ??= platformCleanup(
      "platform-restoration",
      async (run) => {
        await platform.restore({ app, attemptedLaunch, run });
        record("platform-restored");
      },
    ));
  };
  const restoreAndStopApp = async () => {
    const errors: unknown[] = [];
    try {
      await restorePlatform();
    } catch (error) {
      errors.push(error);
    }
    try {
      await stopApp();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Platform restoration or app shutdown failed",
      );
  };
  const close = () =>
    (closing ??= (async () => {
      retainRoot = false;
      cancellation.abort(new Error("Pet session is closed"));
      // Keep the last scenario stage even when callers close in a finally
      // block before Vitest can report their error.
      record("cleanup-started");
      const errors: unknown[] = [];
      if (firstFailure !== undefined) {
        const child = appProcess;
        if (
          child?.pid &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          try {
            record("owned-process-group", processGroup(child.pid));
          } catch (error) {
            record("process-group-unavailable", String(error));
          }
          try {
            execFileSync(
              "/usr/bin/sample",
              [
                String(child.pid),
                "1",
                "1",
                "-file",
                path.join(evidence, `process-${child.pid}.txt`),
              ],
              { timeout: 5000, stdio: "ignore" },
            );
          } catch (error) {
            record("sample-unavailable", String(error));
          }
        }
      }
      // Interrupt an owned app before waiting on startup: a pending driver
      // call may only settle when its process exits. A late launch is adopted
      // and stopped below before it is allowed to observe readiness.
      const interrupted = app;
      try {
        if (app) await restoreAndStopApp();
      } catch (error) {
        errors.push(error);
      }
      try {
        await settleOwnership(pending.catch(() => {}));
        await settleOwnership(Promise.allSettled([...acquisitions]));
      } catch (error) {
        errors.push(error);
      }
      // A late acquisition's own release may fail. Verify that resource here
      // too; an allSettled result must not silently accept a surviving app.
      if (app && app !== interrupted) {
        try {
          await restoreAndStopApp();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await restorePlatform();
      } catch (error) {
        if (!errors.includes(error)) errors.push(error);
      }
      if (options.packagedPlatform && errors.length) retainRoot = true;
      for (const release of releases.toReversed()) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
          if (options.packagedPlatform) retainRoot = true;
        }
      }
      record("cleanup-complete", errors.map(String));
      options.signal?.removeEventListener("abort", cancelled);
      if (errors.length)
        throw new AggregateError(
          firstFailure === undefined ? errors : [firstFailure, ...errors],
          "Pet session cleanup failed",
          { cause: firstFailure },
        );
    })().catch((error: unknown) => {
      // A denied cleanup remains a failure, but callers can release the
      // obstruction and safely retry. Scenario operations stay cancelled.
      closing = undefined;
      platformRestoration = undefined;
      throw error;
    }));
  const cancelled = () => {
    fail(new Error("Pet session cancelled", { cause: options.signal?.reason }));
    void close().catch((error: unknown) =>
      record("cancellation-cleanup-failed", String(error)),
    );
  };
  options.signal?.addEventListener("abort", cancelled, { once: true });
  onTestFinished(async ({ task }) => {
    // Vitest runs onTestFinished before onTestFailed. Capture the failing
    // stage and live OS process here, before cleanup interrupts pending calls.
    if (task.result?.state === "fail") {
      record("test-failed", task.result.errors);
      fail(new Error("Pet scenario failed", { cause: task.result.errors }));
    }
    await close();
  });
  let starting = false;
  const stopProcess = async (
    child: ChildProcess,
    shutdown?: () => Promise<void>,
  ) => {
    if (!child.pid) return;
    record("app-stopping", { pid: child.pid });
    // Playwright gives each Electron process its own process group on macOS.
    // Bound graceful shutdown, then kill only this session's group (including
    // its capture helper), never matching other apps by executable name.
    let permissionError: unknown;
    const signal = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM") {
          permissionError = error;
          // macOS may signal some group members and still report EPERM.
          // Success below requires the leader's exit and no live members;
          // a permission failure that leaves a process alive still fails.
          record("group-signal-partial", {
            code,
            processes: processGroup(child.pid),
          });
        } else if (code !== "ESRCH") throw error;
      }
    };
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forced = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        try {
          signal();
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 5000);
    });
    try {
      if (child.exitCode === null && child.signalCode === null)
        await Promise.race([
          shutdown
            ? shutdown().catch((error: unknown) =>
                record("driver-close-failed", String(error)),
              )
            : Promise.resolve(signal()),
          exited,
          forced,
        ]);
    } catch (error) {
      record("shutdown-signal-failed", String(error));
    } finally {
      clearTimeout(timer);
    }
    // Reap any remaining helper in the owned group even if graceful close
    // rejected or the main process exited before its children.
    signal();
    try {
      await expect
        .poll(
          () => ({
            exited: child.exitCode !== null || child.signalCode !== null,
            // A zombie has exited and cannot execute or retain app resources.
            live: processGroup(child.pid!).filter(
              (line) => !line.trim().split(/\s+/)[4]!.startsWith("Z"),
            ),
          }),
          { timeout: 5000 },
        )
        .toEqual({ exited: true, live: [] });
    } catch (error) {
      if (permissionError)
        throw new AggregateError(
          [permissionError, error],
          "Owned processes survived permission-denied cleanup",
          { cause: error },
        );
      throw error;
    }
    record("app-stopped", { pid: child.pid });
  };
  const stopApp = async () => {
    if (!app) return;
    const current = app;
    const child = appProcess!;
    await stopProcess(child, () => current.close());
    if (app === current) {
      app = undefined;
      appProcess = undefined;
    }
  };
  const finishFailure = async (
    error: unknown,
    message: string,
  ): Promise<never> => {
    fail(error);
    const cleanup = await close().then(
      () => undefined,
      (failure: unknown) => ({ failure }),
    );
    if (cleanup)
      throw new AggregateError([error, cleanup.failure], message, {
        cause: error,
      });
    throw error;
  };
  const run = async <T>(
    label: string,
    action: () => Promise<T>,
    { timeout = 5000 } = {},
  ) => {
    // One driver or filesystem operation per call. A continuation must enter
    // this guard again before its next side effect, including after a timeout.
    try {
      return await step(label, action, timeout);
    } catch (error) {
      return finishFailure(error, "Pet operation and cleanup failed");
    }
  };
  try {
    if (options.signal?.aborted) cancelled();
    active();
    const preparation = (async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "mosey-pet-session-"));
      const ownedRoot = root;
      releases.push(async () => {
        if (retainRoot) {
          record("owned-root-retained", { directory: ownedRoot, evidence });
          return;
        }
        await rm(ownedRoot, { recursive: true, force: true });
      });
      active();
      const profile = path.join(root, "profile");
      await mkdir(profile);
      active();
      if (options.preferences !== undefined)
        await writeFile(
          path.join(profile, "preferences.json"),
          JSON.stringify(options.preferences),
        );

      const packaged = process.env.MOSEY_TEST_MODE === "packaged";
      record(
        "application-variant",
        options.behavior ? "controlled-behavior-v1" : "production-default",
      );
      mark(packaged ? "copy-package" : "start-forge");
      if (packaged)
        execFileSync(
          "/usr/bin/ditto",
          [
            path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
            path.join(root, "Mosey.app"),
          ],
          { timeout: 30000 },
        );
      else {
        releases.push(await startForge({ signal: cancellation.signal }));
        active();
        // app.getAppPath() must resolve inside this session. An existing
        // developer app must never launch our substituted capture producer.
        const directory = path.join(root, "app");
        await mkdir(directory);
        await cp("package.json", path.join(directory, "package.json"));
        await cp(".vite/build", path.join(directory, ".vite/build"), {
          recursive: true,
        });
        await cp("build/native", path.join(directory, "build/native"), {
          recursive: true,
        });
        await symlink(
          path.resolve("node_modules"),
          path.join(directory, "node_modules"),
          "dir",
        );
      }
      active();
      if (options.behavior) {
        const instrumentation = instrumentBehaviorApplication({
          root: ownedRoot,
          packaged,
          options: options.behavior,
          evidence,
          signal: cancellation.signal,
        });
        acquisitions.add(instrumentation);
        void instrumentation.then(
          () => acquisitions.delete(instrumentation),
          () => acquisitions.delete(instrumentation),
        );
        await step("prepare-behavior", () => instrumentation, 30000);
        active();
      }

      const observation = path.join(root, "dock.json");
      const native = packaged
        ? path.join(root, "Mosey.app/Contents/Resources/native")
        : path.join(root, "app/build/native");
      const helper = path.join(native, "dock-runtime");
      if (typeof options.dock === "object") {
        const producer = options.dock;
        const scratch = path.join(root, "producer");
        const shared = async () => ({
          native: await nativeArtifactInventory("build/native"),
          cache: await nativeArtifactInventory("build/swift-module-cache"),
          ...(packaged
            ? {
                packaged: await nativeArtifactInventory(
                  "out/Mosey-darwin-arm64/Mosey.app/Contents/Resources/native",
                ),
              }
            : {}),
        });
        const diagnostic = async () => {
          const files = await nativeArtifactInventory(native);
          return Object.fromEntries(
            Object.entries(files).filter(
              ([file]) =>
                file !== "dock-runtime" && file !== "runtime-receipt.json",
            ),
          );
        };
        const before = await step("producer-shared-inputs", shared);
        const diagnosticBefore = await step(
          "producer-diagnostic-identity",
          diagnostic,
        );
        // Register evidence and invariance verification before any fixture
        // acquisition. This runs before the owned root is removed, on failure too.
        releases.push(() =>
          settleOwnership(
            (async () => {
              const after = await shared();
              const diagnosticAfter = await diagnostic();
              await writeFile(
                path.join(evidence, "native-isolation.json"),
                JSON.stringify(
                  {
                    producer: producer.name,
                    before,
                    after,
                    diagnosticBefore,
                    diagnosticAfter,
                  },
                  null,
                  2,
                ),
              );
              expect(
                after,
                "producer changed shared prepared native inputs",
              ).toEqual(before);
              expect(
                diagnosticAfter,
                "producer changed diagnostic identity",
              ).toEqual(diagnosticBefore);
            })(),
          ),
        );
        await step("producer-scratch", () => mkdir(scratch));
        const preparing = producer.prepare({
          root: scratch,
          evidence,
          signal: cancellation.signal,
          run: (label, action, { timeout = 5000 } = {}) =>
            step(label, action, timeout),
        });
        acquisitions.add(preparing);
        void preparing.then(
          () => acquisitions.delete(preparing),
          () => acquisitions.delete(preparing),
        );
        const bytes = await step(
          "producer-preparation",
          () => preparing,
          60000,
        );
        await step("producer-install", () => writeFile(helper, bytes));
        await step("producer-executable", () => chmod(helper, 0o755));
        record("producer-installed", {
          name: producer.name,
          helper,
          scratch,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          boundary:
            "Scenario-owned producer; product wire parser remains real; no real capture or permission claim",
        });
      } else if (options.dock !== "real") {
        await writeFile(observation, "null");
        // Both adapters substitute only a session-local copy; deleting the
        // owned root also rolls back a partial write or chmod failure.
        await writeFile(
          helper,
          `#!${process.execPath}
import fs from 'node:fs';
const started = performance.now(); let sequence = 0;
console.log(JSON.stringify({type:'environment',protocol:1,processID:process.pid,parentPID:process.ppid}));
setInterval(() => {
  const observation = JSON.parse(fs.readFileSync(${JSON.stringify(observation)}, 'utf8'));
  console.log(JSON.stringify({type:'observation',elapsed:(performance.now()-started)/1000,sequence:++sequence,sourceAgeSeconds:0,callbackAgeSeconds:0,idle:false,reason:observation?'current':'alpha_empty',observation}));
}, 50);
`,
        );
        await chmod(helper, 0o755);
      }
      let executablePath = packaged
        ? path.join(root, "Mosey.app/Contents/MacOS/Mosey")
        : undefined;
      if (options.isolateAppIdentity) {
        mark("isolate-app-identity");
        const bundle = path.join(
          root,
          packaged ? "Mosey.app" : "CrashTest.app",
        );
        if (!packaged)
          execFileSync(
            "/usr/bin/ditto",
            [path.resolve("node_modules/electron/dist/Electron.app"), bundle],
            { timeout: 30000 },
          );
        execFileSync(
          "/usr/libexec/PlistBuddy",
          [
            "-c",
            `Set :CFBundleIdentifier dev.frost.mosey.fault.${path.basename(root)}`,
            path.join(bundle, "Contents/Info.plist"),
          ],
          { timeout: 5000 },
        );
        execFileSync(
          "/usr/bin/codesign",
          ["--force", "--deep", "--sign", "-", bundle],
          { timeout: 30000 },
        );
        executablePath = path.join(
          bundle,
          "Contents/MacOS",
          packaged ? "Mosey" : "Electron",
        );
      }
      const platform = options.packagedPlatform;
      if (platform) {
        if (!packaged || options.isolateAppIdentity)
          throw new Error(
            "Platform ownership requires its own packaged app identity",
          );
        platformArmed = true;
        // Compensation is installed before any signing/registration attempt.
        releases.push(() =>
          platformCleanup("platform-release", async (run) => {
            await platform.release?.({ run });
          }),
        );
        await platform.prepare?.({
          bundle: path.join(root, "Mosey.app"),
          evidence,
          signal: cancellation.signal,
          run: (label, action, { timeout = 5000 } = {}) =>
            step(
              label,
              () => {
                // An aborted OS acquisition may still be completing. Settle it
                // before compensation can unregister or delete the owned bundle.
                const operation = action();
                acquisitions.add(operation);
                void operation.then(
                  () => acquisitions.delete(operation),
                  () => acquisitions.delete(operation),
                );
                return operation;
              },
              timeout,
            ),
        });
        active();
      }

      return {
        directory: root,
        profile,
        packaged,
        observation,
        executablePath,
      };
    })();
    pending = preparation;
    const { directory, profile, packaged, observation, executablePath } =
      await preparation;

    const launch = async ({ timeout = 30000 } = {}) => {
      active();
      if (app || starting)
        throw new Error(
          "Pet session already has an application; use restart()",
        );
      starting = true;
      attemptedLaunch = true;
      const launching = (async () => {
        mark("launch");
        const args = [
          ...(packaged ? [] : [path.join(directory, "app")]),
          `--user-data-dir=${profile}`,
          ...(options.isolateAppIdentity
            ? ["-ApplePersistenceIgnoreState", "YES"]
            : []),
          `--force-device-scale-factor=${requestedScale}`,
        ];
        // Playwright owns a launch that rejects before returning. Once it
        // returns, even after a test deadline, the session owns that process.
        const acquisition = electron
          .launch({
            ...(executablePath ? { executablePath } : {}),
            args,
            timeout,
            ...(options.recordVideo
              ? { recordVideo: options.recordVideo }
              : {}),
          })
          .then(async (acquired) => {
            app = acquired;
            appProcess = app.process();
            processes.push(appProcess);
            const child = appProcess;
            child.once("exit", (code, signal) =>
              record("app-exited", { pid: child.pid, code, signal }),
            );
            appProcess.stderr?.on("data", (data: Buffer) =>
              appendFileSync(path.join(evidence, "stderr.txt"), data),
            );
            record("app-acquired");
            if (closing || cancellation.signal.aborted) {
              await restoreAndStopApp();
              throw new Error(
                "Pet session cancelled while the application was launching",
              );
            }
            return acquired;
          });
        acquisitions.add(acquisition);
        void acquisition.then(
          () => acquisitions.delete(acquisition),
          () => acquisitions.delete(acquisition),
        );
        const current = await step("launch", () => acquisition, timeout);
        active();
        const renderer = observePetRenderer(current);
        const readiness = (async () => {
          // Observe without handling or suppressing the default fatal error.
          // A native error dialog can block later inspector calls and hide the
          // original exception behind a test timeout.
          await step("exception-monitor", () =>
            current.evaluate(
              (_electron, output) => {
                process.on("uncaughtExceptionMonitor", (error, origin) => {
                  process
                    .getBuiltinModule("node:fs")
                    .appendFileSync(
                      output,
                      JSON.stringify({ origin, stack: error.stack }) + "\n",
                    );
                });
              },
              path.join(evidence, "main-exceptions.jsonl"),
            ),
          );
          mark("initial-document");
          const pet = await step(
            "initial-window",
            () => current.firstWindow({ timeout: 15000 }),
            15000,
          );
          await step(
            "initial-document",
            () => pet.waitForLoadState("load"),
            15000,
          );
          mark("initial-presentation-and-paint");
          const observed = await step(
            "initial-presentation-and-paint",
            () => renderer.waitUntilReady({ timeout: 15000 }),
            15000,
          );
          record("observed-scale", {
            requested: requestedScale,
            observed: observed.scaleFactor,
          });
          if (observed.scaleFactor !== requestedScale)
            throw new Error(
              `Expected scale ${requestedScale}, observed ${observed.scaleFactor}`,
            );
          active();
          mark("ready");
          return { app: current, pet, renderer };
        })();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Pet presentation or painted pixels did not become ready within 30s",
                ),
              ),
            30000,
          );
        });
        try {
          // evaluate() can hang if the main process stalls. This deadline also
          // frees test-exit cleanup to reach the owned process's kill fallback.
          return await Promise.race([readiness, deadline]);
        } finally {
          clearTimeout(timer);
        }
      })();
      pending = launching;
      try {
        return await launching;
      } catch (error) {
        record("launch-failed", String(error));
        return finishFailure(error, "Pet launch and cleanup failed");
      } finally {
        starting = false;
      }
    };
    return {
      profile,
      evidence,
      mark,
      launch,
      run,
      async launchDuplicate() {
        active();
        if (!app || !appProcess)
          throw new Error("Pet session has no application");
        const executable = appProcess.spawnfile;
        let child: ChildProcess | undefined;
        releases.push(async () => {
          if (child) await stopProcess(child);
        });
        return run(
          "duplicate-launch",
          async () => {
            child = spawn(
              executable,
              [
                ...(packaged ? [] : [path.join(directory, "app")]),
                `--user-data-dir=${profile}`,
                `--force-device-scale-factor=${requestedScale}`,
              ],
              {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
                stdio: "pipe",
                detached: true,
              },
            );
            processes.push(child);
            record("duplicate-acquired");
            child.stderr?.on("data", (data: Buffer) =>
              appendFileSync(path.join(evidence, "stderr.txt"), data),
            );
            await new Promise<void>((resolve, reject) => {
              child!.once("error", reject);
              child!.once("exit", (code, signal) => {
                record("duplicate-exited", { pid: child!.pid, code, signal });
                if (code === 0 && signal === null) resolve();
                else
                  reject(
                    new Error(
                      `Duplicate launch failed: code=${code}, signal=${signal}`,
                    ),
                  );
              });
            });
            return { pid: child.pid, exitCode: child.exitCode };
          },
          { timeout: 10000 },
        );
      },
      async quit({ action }: { action?: () => Promise<unknown> } = {}) {
        active();
        if (!app || !appProcess)
          throw new Error("Pet session has no application");
        mark("normal-exit");
        const child = appProcess;
        // Trigger the product's quit action, but judge the owned OS process.
        // A driver acknowledgement may never arrive even after a genuine exit.
        // A caller may select the body menu's real quit item. Keep its single
        // driver action under the same cancellation guard and OS exit gate.
        const request =
          action ??
          (() =>
            app!.evaluate(({ Menu }) => {
              const item = Menu.getApplicationMenu()
                ?.items.find((item) => item.label === "Mosey")
                ?.submenu?.items.find((item) => item.label === "Quit Mosey");
              if (!item) throw new Error("Missing Quit Mosey menu item");
              item.click();
            }));
        void Promise.resolve()
          .then(() => {
            active();
            return request();
          })
          .then(
            () => record("quit-acknowledged"),
            (error: unknown) =>
              record("quit-acknowledgement-failed", String(error)),
          );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            const exited = () => {
              clearTimeout(timer);
              if (child.exitCode === 0 && child.signalCode === null) resolve();
              else
                reject(
                  new Error(
                    `normal-exit failed: code=${child.exitCode}, signal=${child.signalCode}`,
                  ),
                );
            };
            if (child.exitCode !== null || child.signalCode !== null) exited();
            else {
              child.once("exit", exited);
              timer = setTimeout(() => {
                child.off("exit", exited);
                reject(
                  new Error("normal-exit did not complete within 10000ms"),
                );
              }, 10000);
            }
          });
          active();
          record("normal-exit-complete");
          await stopApp();
        } catch (error) {
          record("normal-exit-failed", String(error));
          return finishFailure(error, "Pet quit and cleanup failed");
        } finally {
          clearTimeout(timer);
        }
      },
      async writeProfileFile(name: string, contents: string) {
        active();
        if (path.basename(name) !== name)
          throw new Error("Profile file must be a basename");
        await run(`profile-write:${name}`, () =>
          writeFile(path.join(profile, name), contents),
        );
      },
      restart() {
        active();
        if (starting) throw new Error("Pet session is still launching");
        starting = true;
        const restarting = stopApp().then(
          () => {
            // Release the reservation and enter launch's guard in one turn.
            starting = false;
            return launch();
          },
          (error: unknown) => {
            starting = false;
            throw error;
          },
        );
        pending = restarting;
        return restarting;
      },
      async setDockObservation(value: DockObservation | null) {
        active();
        if (options.dock !== "controlled")
          throw new Error("Controlled Dock input was not selected");
        // Readers see one complete protocol value, even during an update.
        const pending = `${observation}.tmp`;
        await writeFile(pending, JSON.stringify(value));
        active();
        await rename(pending, observation);
      },
      close,
    };
  } catch (error) {
    record("preparation-failed", String(error));
    return finishFailure(error, "Pet preparation and cleanup failed");
  }
}
