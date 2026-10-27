import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startForge } from "./support/forge";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

test("diagnostic status keeps the latest Retry during a native permission query", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-dock-status-"));
  let app: ElectronApplication | undefined;
  let stopForge: (() => Promise<void>) | undefined;
  let restore: (() => Promise<void>) | undefined;
  try {
    // No capture is started: preserve hidden intent while exercising the real
    // diagnostic document and real OS permission result, without a fake grant.
    await mkdir(path.join(root, "profile"));
    await writeFile(
      path.join(root, "profile/preferences.json"),
      JSON.stringify({
        version: 3,
        character: "corgi",
        visibility: "hidden",
        size: 160,
      }),
    );
    if (!packaged) stopForge = await startForge();
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.resolve(
              "out/Mosey-darwin-arm64/Mosey.app/Contents/MacOS/Mosey",
            ),
            args: [`--user-data-dir=${root}/profile`],
          }
        : { args: [".", `--user-data-dir=${root}/profile`] },
    );
    await (
      await app.firstWindow()
    )
      .locator("canvas")
      .waitFor({ state: "attached" });
    const invoke = (section: string, label: string) =>
      app!.evaluate(
        ({ Menu }, { section, label }) => {
          Menu.getApplicationMenu()!
            .items.find((item) => item.label === section)!
            .submenu!.items.find((item) => item.label === label)!
            .click();
        },
        { section, label },
      );
    const created = app.waitForEvent("window");
    await invoke("Dock validation", "Show Dock validation status");
    const diagnostic = await created;
    await expect
      .poll(() => diagnostic.getByRole("status").innerText())
      .toBe("Not started");
    const hooks = await app.evaluateHandle(
      ({ BrowserWindow, Menu, systemPreferences }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.getTitle() === "Mosey Dock validation",
        )!;
        const contents = window.webContents;
        const originalPermission = systemPreferences.getMediaAccessStatus;
        const originalLoad = contents.loadURL;
        const state = {
          armed: false,
          dispatches: 0,
          started: 0,
          pending: 0,
          permissionReads: 0,
        };
        contents.loadURL = function (this: typeof contents, ...args) {
          state.started++;
          state.pending++;
          try {
            return Reflect.apply(originalLoad, this, args).finally(() => {
              state.pending--;
            });
          } catch (error) {
            state.pending--;
            throw error;
          }
        };
        systemPreferences.getMediaAccessStatus = function (
          this: typeof systemPreferences,
          mediaType,
        ) {
          // Delegate exactly once with the real argument and preserve its return
          // and exception. Inject only the public Retry input at this boundary.
          const value = Reflect.apply(originalPermission, this, [mediaType]);
          state.permissionReads++;
          if (mediaType === "screen" && state.armed) {
            state.armed = false;
            state.dispatches++;
            Menu.getApplicationMenu()!
              .items.find((item) => item.label === "Mosey")!
              .submenu!.items.find(
                (item) => item.label === "Retry Dock interaction",
              )!
              .click();
          }
          return value;
        };
        return {
          state,
          windowID: window.id,
          restore: () => {
            state.armed = false;
            systemPreferences.getMediaAccessStatus = originalPermission;
            if (!contents.isDestroyed()) contents.loadURL = originalLoad;
          },
        };
      },
    );
    restore = () => hooks.evaluate((hooks) => hooks.restore());
    await hooks.evaluate((hooks) => {
      hooks.state.armed = true;
    });
    await invoke("Dock validation", "Stop Dock validation");
    expect(await hooks.evaluate((hooks) => hooks.state.dispatches)).toBe(1);
    await expect
      .poll(
        async () => {
          const first = await hooks.evaluate((hooks) => ({ ...hooks.state }));
          if (!first.started || first.pending) return false;
          await app!.evaluate(
            () => new Promise<void>((resolve) => setImmediate(resolve)),
          );
          const last = await hooks.evaluate((hooks) => ({ ...hooks.state }));
          const idle = await app!.evaluate(
            ({ BrowserWindow }, id) =>
              !BrowserWindow.fromId(id)!.webContents.isLoading(),
            await hooks.evaluate((hooks) => hooks.windowID),
          );
          return idle && !last.pending && first.started === last.started;
        },
        { timeout: 5000 },
      )
      .toBe(true);
    const final = await diagnostic.getByRole("status").innerText();
    await mkdir("test-results", { recursive: true });
    await writeFile(
      `test-results/${packaged ? "packaged" : "development"}-dock-status-reentry.json`,
      JSON.stringify({
        scope:
          "Controlled public input interleaving; real permission result; no capture; not proof that the native API caused historical runs",
        trace: await hooks.evaluate((hooks) => hooks.state),
        final,
      }),
    );
    expect(final).toBe("Stopped: product Dock interaction requested");
  } finally {
    await restore?.().catch(() => {});
    await app?.close().catch(() => {});
    await stopForge?.();
    await rm(root, { recursive: true, force: true });
  }
});
