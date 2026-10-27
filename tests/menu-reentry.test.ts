import { test, expect, onTestFinished } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startForge } from "./support/forge";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

test.each([
  ["build", "Show Mosey"],
  ["build", "Hide Mosey"],
  ["install", "Show Mosey"],
  ["install", "Hide Mosey"],
] as const)(
  "menu %s preserves the newer %s choice",
  async (boundary, command) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mosey-menu-reentry-"));
    let app: ElectronApplication | undefined;
    let stop: (() => Promise<void>) | undefined;
    let restore: (() => Promise<void>) | undefined;
    let cleanup: Promise<void> | undefined;
    let finished = false;
    const dispose = () => {
      finished = true;
      if (cleanup) return cleanup;
      const ownedApp = app;
      const ownedStop = stop;
      const ownedRestore = restore;
      app = undefined;
      stop = undefined;
      restore = undefined;
      cleanup = (async () => {
        const child = ownedApp?.process();
        // A native exception dialog can block both hook restoration and quit.
        // The fallback owns only this test's isolated child, including timeout.
        const deadline = child
          ? setTimeout(() => child.kill("SIGKILL"), 5000)
          : undefined;
        try {
          await ownedRestore?.().catch(() => {});
          await ownedApp?.close().catch(() => {});
          if (child && child.exitCode === null && child.signalCode === null)
            await new Promise<void>((resolve) =>
              child.once("exit", () => resolve()),
            );
        } finally {
          clearTimeout(deadline);
          await ownedStop?.();
          await rm(root, { recursive: true, force: true });
        }
      })();
      return cleanup;
    };
    const ensureRunning = async () => {
      if (!finished) return;
      // A timed-out launch can still resolve later. Finish the earlier cleanup,
      // then take ownership of any newly acquired app or Forge process as well.
      await cleanup;
      cleanup = undefined;
      await dispose();
      throw new Error("Test finished while acquiring application resources");
    };
    onTestFinished(dispose);
    const visible = command === "Show Mosey";
    try {
      await writeFile(
        path.join(root, "preferences.json"),
        JSON.stringify({
          version: 3,
          character: "corgi",
          visibility: visible ? "hidden" : "visible",
          size: 160,
        }),
      );
      await ensureRunning();
      if (!packaged) {
        stop = await startForge();
        await ensureRunning();
      }
      app = await electron.launch({
        ...(packaged
          ? {
              executablePath: path.resolve(
                "out/Mosey-darwin-arm64/Mosey.app/Contents/MacOS/Mosey",
              ),
            }
          : {}),
        args: [...(packaged ? [] : ["."]), `--user-data-dir=${root}`],
      });
      await ensureRunning();
      const pet = await app.firstWindow();
      await pet.waitForLoadState("networkidle");
      const hooks = await app.evaluateHandle(
        ({ Menu }, { boundary, command }) => {
          const build = Menu.buildFromTemplate;
          const install = Menu.setApplicationMenu;
          let armed = true;
          let inputs = 0;
          const input = (menu: Electron.Menu | null) => {
            const item = menu?.items
              .find((item) => item.label === "Mosey")
              ?.submenu?.items.find((item) => item.label === command);
            if (!armed || !item) return;
            armed = false;
            inputs++;
            // Inject only the newer public visibility command at the native
            // boundary. Delegate the original native operation exactly once.
            // No preferences, behavior state or menu revisions are set by tests.
            item.click();
          };
          Menu.buildFromTemplate = function (template) {
            const menu = Reflect.apply(build, this, [template]);
            if (boundary === "build") input(menu);
            return menu;
          };
          Menu.setApplicationMenu = function (menu) {
            if (boundary === "install") input(menu);
            return Reflect.apply(install, this, [menu]);
          };
          return {
            inputs: () => inputs,
            restore: () => {
              armed = false;
              Menu.buildFromTemplate = build;
              Menu.setApplicationMenu = install;
            },
          };
        },
        { boundary, command },
      );
      restore = () => hooks.evaluate((hooks) => hooks.restore());
      const observed = await app.evaluate(
        async ({ Menu, BrowserWindow, app }) => {
          // Dispatch user input on the ordinary main loop, rather than directly
          // interrupting a Node timer callback through inspector evaluation.
          // The controlled reentry inside the native menu boundary remains intact.
          await new Promise<void>((resolve) => setImmediate(resolve));
          const items = () =>
            Menu.getApplicationMenu()!.items.find(
              (item) => item.label === "Mosey",
            )!.submenu!.items;
          // Activation refreshes the menu from the previous choice. A newer
          // command arrives while that native refresh is still in progress.
          app.emit("activate");
          return {
            menu: items().map((item) => item.label),
            visible: BrowserWindow.getAllWindows()
              .find((window) => window.getTitle() === "Mosey")!
              .isVisible(),
          };
        },
      );
      const preferences: unknown = JSON.parse(
        await readFile(path.join(root, "preferences.json"), "utf8"),
      );
      await mkdir("test-results", { recursive: true });
      await writeFile(
        `test-results/${packaged ? "packaged" : "development"}-menu-reentry-${boundary}-${visible ? "show" : "hide"}.json`,
        JSON.stringify(
          {
            scope:
              "Controlled public input interleaving at the native menu boundary",
            inputs: await hooks.evaluate((hooks) => hooks.inputs()),
            observed,
            preferences,
          },
          null,
          2,
        ),
      );
      expect(await hooks.evaluate((hooks) => hooks.inputs())).toBe(1);
      expect(preferences).toMatchObject({
        visibility: visible ? "visible" : "hidden",
      });
      expect(observed.visible).toBe(visible);
      expect(observed.menu).toContain(visible ? "Hide Mosey" : "Show Mosey");
      expect(observed.menu).not.toContain(command);
    } catch (error) {
      await mkdir("test-results", { recursive: true });
      await app
        ?.windows()[0]
        ?.screenshot({
          path: `test-results/failure-menu-reentry-${boundary}-${visible ? "show" : "hide"}-${packaged ? "packaged" : "development"}.png`,
          timeout: 3000,
        })
        .catch(() => {});
      throw error;
    } finally {
      await dispose();
    }
  },
);
