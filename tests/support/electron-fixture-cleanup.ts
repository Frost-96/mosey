import type { ElectronApplication } from "playwright";
import { closeOwnedElectron } from "./owned-electron.ts";
import { withinDeadline } from "./deadline.ts";

type OwnedApplication = Pick<ElectronApplication, "close" | "process">;

// Legacy scenarios retain their protocol fixtures and assertions. This boundary
// only owns launched processes and releases their temporary native substitutions.
export function createElectronFixtureCleanup(
  releases: (() => void | Promise<void>)[],
  beforeClose?: () => void | Promise<void>,
) {
  let owned:
    | { app: OwnedApplication; child: ReturnType<OwnedApplication["process"]> }
    | undefined;
  let launching: Promise<OwnedApplication> | undefined;
  let stopping: Promise<void> | undefined;
  let closing = false;
  let cleanupPromise: Promise<void> | undefined;
  const closedDuringLaunch = new Error("Electron fixture closed during launch");
  const closeApp = (requireGraceful = false) =>
    (stopping ??= (async () => {
      const current = owned;
      owned = undefined;
      if (current) {
        const result = await closeOwnedElectron(current.app, current.child);
        if (requireGraceful && result.forced)
          throw new Error("Application close required forced termination");
      }
    })().finally(() => {
      stopping = undefined;
    }));

  const launch = async <T extends OwnedApplication>(
    start: () => Promise<T>,
  ) => {
    if (closing) throw new Error("Cannot launch a closed Electron fixture");
    if (owned || launching || stopping)
      throw new Error("Electron fixture already owns an application");
    const pending = start().then(async (app) => {
      // Capture before a driver call can stall or explicit quit detaches it.
      owned = { app, child: app.process() };
      if (closing) {
        await closeApp();
        throw closedDuringLaunch;
      }
      return app;
    });
    launching = pending;
    try {
      return await pending;
    } finally {
      if (launching === pending) launching = undefined;
    }
  };

  const cleanup = async (failure?: { error: unknown }) => {
    closing = true;
    cleanupPromise ??= (async () => {
      const pendingLaunch = launching;
      const errors: unknown[] = [];
      const attempt = async (release: () => void | Promise<void>) => {
        try {
          await release();
        } catch (error) {
          if (!errors.includes(error)) errors.push(error);
        }
      };
      if (beforeClose)
        await attempt(() =>
          withinDeadline("Electron before-close", beforeClose),
        );
      await attempt(closeApp);
      // A timed-out test may still be awaiting launch. Its late process must
      // exit before restoring a helper that the process could still execute.
      await attempt(async () => {
        try {
          await pendingLaunch;
        } catch (error) {
          if (error !== closedDuringLaunch) throw error;
        }
      });
      await attempt(closeApp);
      for (const release of releases) await attempt(release);
      if (errors.length)
        throw new AggregateError(errors, "Electron fixture cleanup failed");
    })();
    try {
      await cleanupPromise;
    } catch (error) {
      if (failure)
        throw new AggregateError(
          [failure.error, error],
          "Application test and cleanup failed",
          { cause: error },
        );
      throw error;
    }
    if (failure) throw failure.error;
  };
  // Scenario restarts must prove a graceful exit. Final cleanup can force an
  // owned process down, while retaining the failure that required cleanup.
  return { launch, closeApp: () => closeApp(true), cleanup };
}
