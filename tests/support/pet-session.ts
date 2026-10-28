import { expect, onTestFinished } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
import { observePetRenderer } from "./pet-renderer";

type SessionOptions = {
  preferences?: unknown;
  // Destructive main-process faults must not share macOS restoration history.
  isolateAppIdentity?: boolean;
  // Synthetic inputs prove application behavior at the native wire boundary,
  // never real Dock capture, permission, focus or cross-application input.
  dock: "real" | "empty" | "controlled";
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
  let stage = "preparing";
  let root: string | undefined;
  let app: ElectronApplication | undefined;
  let appProcess: ReturnType<ElectronApplication["process"]> | undefined;
  const processes: ReturnType<ElectronApplication["process"]>[] = [];
  const record = (event: string, detail?: unknown) => {
    appendFileSync(
      path.join(evidence, "progress.jsonl"),
      JSON.stringify({
        event,
        stage,
        elapsed: performance.now() - started,
        test: expect.getState().currentTestName,
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
  let closing: Promise<void> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const close = () =>
    (closing ??= (async () => {
      // Keep the last scenario stage even when callers close in a finally
      // block before Vitest can report their error.
      record("cleanup-started");
      const errors: unknown[] = [];
      // Interrupt an owned app before waiting on startup: a pending driver
      // call may only settle when its process exits. A late launch is adopted
      // and stopped below before it is allowed to observe readiness.
      try {
        await stopApp();
      } catch (error) {
        errors.push(error);
      }
      await pending.catch(() => {});
      for (const release of releases.reverse()) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      record("cleanup-complete", errors.map(String));
      if (errors.length)
        throw new AggregateError(errors, "Pet session cleanup failed");
    })());
  onTestFinished(async ({ task }) => {
    // Vitest runs onTestFinished before onTestFailed. Capture the failing
    // stage and live OS process here, before cleanup interrupts pending calls.
    if (task.result?.state === "fail") {
      record("test-failed", task.result.errors);
      const child = appProcess;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
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
    await close();
  });
  let starting = false;
  const stopApp = async () => {
    if (!app) return;
    const current = app;
    app = undefined;
    // The driver detaches its process accessor after an explicit quit/crash.
    // Retain the owned OS handle from acquisition through final cleanup.
    const child = appProcess!;
    appProcess = undefined;
    record("app-stopping", { pid: child.pid });
    // Playwright gives each Electron process its own process group on macOS.
    // Bound graceful shutdown, then kill only this session's group (including
    // its capture helper), never matching other apps by executable name.
    const signal = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM") {
          // macOS may signal some group members and still report EPERM.
          // Success below requires the leader's exit and no live members;
          // a permission failure that leaves a process alive still fails.
          record("group-signal-partial", processGroup(child.pid));
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
        await Promise.race([current.close(), exited, forced]);
    } finally {
      clearTimeout(timer);
      // Reap any remaining helper in the owned group even if graceful close
      // rejected or the main process exited before its children.
      signal();
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
      record("app-stopped", { pid: child.pid });
    }
  };
  try {
    const preparation = (async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "mosey-pet-session-"));
      const ownedRoot = root;
      releases.push(() => rm(ownedRoot, { recursive: true, force: true }));
      const profile = path.join(root, "profile");
      await mkdir(profile);
      if (options.preferences !== undefined)
        await writeFile(
          path.join(profile, "preferences.json"),
          JSON.stringify(options.preferences),
        );

      const packaged = process.env.MOSEY_TEST_MODE === "packaged";
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
        releases.push(await startForge());
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

      const observation = path.join(root, "dock.json");
      if (options.dock !== "real") {
        await writeFile(observation, "null");
        const helper = packaged
          ? path.join(root, "Mosey.app/Contents/Resources/native/dock-runtime")
          : path.join(root, "app/build/native/dock-runtime");
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
      releases.push(stopApp);

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

    const launch = async () => {
      if (closing) throw new Error("Pet session is closed");
      if (app || starting)
        throw new Error(
          "Pet session already has an application; use restart()",
        );
      starting = true;
      const launching = (async () => {
        mark("launch");
        const args = [
          ...(packaged ? [] : [path.join(directory, "app")]),
          `--user-data-dir=${profile}`,
          ...(options.isolateAppIdentity
            ? ["-ApplePersistenceIgnoreState", "YES"]
            : []),
          `--force-device-scale-factor=${options.scaleFactor ?? process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"}`,
        ];
        // Playwright owns a launch that rejects before returning. Once it
        // returns, even after a test deadline, the session owns that process.
        app = await electron.launch({
          ...(executablePath ? { executablePath } : {}),
          args,
          timeout: 30000,
          ...(options.recordVideo ? { recordVideo: options.recordVideo } : {}),
        });
        appProcess = app.process();
        processes.push(appProcess);
        appProcess.stderr?.on("data", (data: Buffer) =>
          appendFileSync(path.join(evidence, "stderr.txt"), data),
        );
        record("app-acquired");
        if (closing) {
          await stopApp();
          throw new Error(
            "Pet session closed while the application was launching",
          );
        }
        const current = app;
        const renderer = observePetRenderer(current);
        const readiness = (async () => {
          // Observe without handling or suppressing the default fatal error.
          // A native error dialog can block later inspector calls and hide the
          // original exception behind a test timeout.
          await current.evaluate(
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
          );
          mark("initial-document");
          const pet = await current.firstWindow({ timeout: 15000 });
          await pet.waitForLoadState("load");
          mark("initial-presentation-and-paint");
          await renderer.waitUntilReady({ timeout: 15000 });
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
        try {
          await close();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "Pet launch and cleanup failed",
            { cause: cleanup },
          );
        }
        throw error;
      } finally {
        starting = false;
      }
    };
    return {
      profile,
      mark,
      launch,
      restart() {
        if (closing) throw new Error("Pet session is closed");
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
        if (options.dock !== "controlled")
          throw new Error("Controlled Dock input was not selected");
        // Readers see one complete protocol value, even during an update.
        const pending = `${observation}.tmp`;
        await writeFile(pending, JSON.stringify(value));
        await rename(pending, observation);
      },
      close,
    };
  } catch (error) {
    record("preparation-failed", String(error));
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Pet preparation and cleanup failed",
        { cause: cleanup },
      );
    }
    throw error;
  }
}
