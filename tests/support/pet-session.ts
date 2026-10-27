import { expect, onTestFinished } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
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
import type { DockObservation } from "../../src/platform/dock-runtime-protocol";
import { startForge } from "./forge";

type SessionOptions = {
  preferences?: unknown;
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

// A session owns its profile, launcher, substituted capture producer and every
// app it launches. Cleanup is registered before acquisition and unwinds in
// reverse order, continuing even when one release fails. Test exit is a safety
// net; close() also permits several independent profiles in a single scenario.
export async function createPetTestSession(options: SessionOptions) {
  const releases: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const close = () =>
    (closing ??= (async () => {
      // A timed-out test may finish while startup is still acquiring a
      // process or replacing a helper. Let that acquisition settle before
      // releasing its resources, so it cannot write after restoration.
      await pending.catch(() => {});
      const errors: unknown[] = [];
      for (const release of releases.reverse()) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Pet session cleanup failed");
    })());
  onTestFinished(close);
  let app: ElectronApplication | undefined;
  let starting = false;
  const stopApp = async () => {
    if (!app) return;
    const current = app;
    app = undefined;
    const child = current.process();
    // Playwright gives each Electron process its own process group on macOS.
    // Bound graceful shutdown, then kill only this session's group (including
    // its capture helper), never matching other apps by executable name.
    const signal = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
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
      await Promise.race([current.close(), forced]);
    } finally {
      clearTimeout(timer);
      // Reap any remaining helper in the owned group even if graceful close
      // rejected or the main process exited before its children.
      signal();
      await exited;
    }
  };
  try {
    const preparation = (async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "mosey-pet-session-"));
      releases.push(() => rm(root, { recursive: true, force: true }));
      const profile = path.join(root, "profile");
      await mkdir(profile);
      if (options.preferences !== undefined)
        await writeFile(
          path.join(profile, "preferences.json"),
          JSON.stringify(options.preferences),
        );

      const packaged = process.env.MOSEY_TEST_MODE === "packaged";
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
      releases.push(stopApp);

      return { root, profile, packaged, observation };
    })();
    pending = preparation;
    const { root, profile, packaged, observation } = await preparation;

    const launch = async () => {
      if (closing) throw new Error("Pet session is closed");
      if (app || starting)
        throw new Error(
          "Pet session already has an application; use restart()",
        );
      starting = true;
      const launching = (async () => {
        const args = [
          `--user-data-dir=${profile}`,
          ...(options.scaleFactor
            ? [`--force-device-scale-factor=${options.scaleFactor}`]
            : []),
        ];
        // Playwright owns process cleanup if launch rejects before returning
        // an app. From this assignment onward the session owns shutdown.
        app = await electron.launch({
          ...(packaged
            ? {
                executablePath: path.join(
                  root,
                  "Mosey.app/Contents/MacOS/Mosey",
                ),
                args,
              }
            : { args: [path.join(root, "app"), ...args] }),
          timeout: 30000,
          ...(options.recordVideo ? { recordVideo: options.recordVideo } : {}),
        });
        const readiness = (async () => {
          const pet = await app.firstWindow({ timeout: 15000 });
          // The window begins show:false. did-finish-load applies the saved
          // visibility, so do not classify that transient startup hiding as
          // a hidden scenario before the document has finished loading.
          await pet.waitForLoadState("load");
          // The public label is published after atlas decode. Hidden pets need
          // this presentation, but cannot paint while document.hidden is true.
          await expect
            .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
              timeout: 15000,
            })
            .toMatch(/^(鲸鱼娘|柯基) · /);
          const { visibility } = await pet.evaluate(() =>
            window.mosey.getPresentation(),
          );
          if (visibility === "visible") {
            await expect
              .poll(
                () =>
                  app!.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()
                      .find((window) => window.getTitle() === "Mosey")!
                      .isVisible(),
                  ),
                { timeout: 15000 },
              )
              .toBe(true);
            await expect
              .poll(
                () =>
                  pet.evaluate(() => {
                    const canvas = document.querySelector("canvas")!;
                    const pixels = canvas
                      .getContext("2d")!
                      .getImageData(0, 0, canvas.width, canvas.height).data;
                    for (let i = 3; i < pixels.length; i += 4)
                      if (pixels[i]! >= 128) return true;
                    return false;
                  }),
                { timeout: 15000 },
              )
              .toBe(true);
          }
          return { app, pet };
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
        await close();
        throw error;
      } finally {
        starting = false;
      }
    };
    return {
      profile,
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
    await close();
    throw error;
  }
}
