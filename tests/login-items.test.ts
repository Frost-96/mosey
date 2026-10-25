import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

test.runIf(process.env.MOSEY_TEST_MODE === "packaged")(
  "login launch follows the packaged app service across changes, quit and restart",
  async () => {
    await mkdir("test-results", { recursive: true });
    const root = await mkdtemp(path.resolve("test-results/mosey-login-"));
    const bundle = path.join(root, "Mosey.app");
    const identity = `dev.frost.mosey.login-test-${Date.now()}`;
    const lsregister =
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    let app: ElectronApplication | undefined;
    let prepared = false;
    let failure: unknown;
    const cleanupErrors: string[] = [];
    const evidence: unknown[] = [];
    const read = async () => {
      const result = await app!.evaluate(({ Menu, app }) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((entry) => entry.label === "Mosey")
          ?.submenu?.items.find((entry) => entry.label === "Launch at Login");
        return {
          system: app.getLoginItemSettings({ type: "mainAppService" }),
          checked: item?.checked,
          enabled: item?.enabled,
          labels: Menu.getApplicationMenu()
            ?.items.find((entry) => entry.label === "Mosey")
            ?.submenu?.items.map((item) => item.label),
          appPath: app.getAppPath(),
          executable: process.execPath,
        };
      });
      expect(result.checked).toBe(
        result.system.status === "enabled" && result.system.openAtLogin,
      );
      expect(result.enabled).toBe(true);
      evidence.push(result);
      return result;
    };
    const launch = async () => {
      app = await electron.launch({
        executablePath: path.join(bundle, "Contents/MacOS/Mosey"),
        args: [`--user-data-dir=${path.join(root, "profile")}`],
        timeout: 20000,
      });
      await app.firstWindow();
      await app.context().setOffline(true);
    };
    const click = async () =>
      app!.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((entry) => entry.label === "Mosey")
          ?.submenu?.items.find((entry) => entry.label === "Launch at Login");
        if (!item?.enabled) throw new Error("Login launch menu unavailable");
        item.click();
      });
    const quit = async () => {
      const child = app!.process();
      const closed = app!.waitForEvent("close");
      await app!.evaluate(({ Menu }) => {
        Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "Mosey")
          ?.submenu?.items.find((item) => item.label === "Quit Mosey")
          ?.click();
      });
      await closed;
      app = undefined;
      await expect.poll(() => child.exitCode).toBe(0);
    };
    try {
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        bundle,
      ]);
      execFileSync("/usr/libexec/PlistBuddy", [
        "-c",
        `Set :CFBundleIdentifier ${identity}`,
        path.join(bundle, "Contents/Info.plist"),
      ]);
      execFileSync("/usr/bin/codesign", [
        "--force",
        "--deep",
        "--identifier",
        identity,
        "--sign",
        "-",
        bundle,
      ]);
      execFileSync(lsregister, ["-f", bundle]);
      prepared = true;
      await launch();
      const fresh = await read();
      expect(fresh.system.openAtLogin).toBe(false);
      expect(fresh.labels?.join(" ")).not.toContain("unavailable");
      await click();
      const requested = await read();
      expect(["enabled", "requires-approval"]).toContain(
        requested.system.status,
      );
      await quit();
      await launch();
      const restarted = await read();
      expect(restarted.system.status).toBe(requested.system.status);
      expect(restarted.system.openAtLogin).toBe(requested.system.openAtLogin);
      // Change the OS boundary directly, as System Settings can while running.
      // A returning app refreshes without a competing persisted preference.
      await app!.evaluate(({ app }) => {
        app.setLoginItemSettings({
          type: "mainAppService",
          openAtLogin: false,
        });
        app.emit("activate");
      });
      expect((await read()).system.openAtLogin).toBe(false);
      // Prove explicit Off through the product menu before another ordinary Quit.
      await click();
      const reenabled = await read();
      if (reenabled.system.status === "requires-approval") {
        await app!.evaluate(({ Menu }) => {
          Menu.getApplicationMenu()
            ?.items.find((item) => item.label === "Mosey")
            ?.submenu?.items.find(
              (item) => item.label === "Cancel Pending Login Launch",
            )
            ?.click();
        });
      } else await click();
      expect((await read()).system.openAtLogin).toBe(false);
      await quit();
      await launch();
      expect((await read()).system.openAtLogin).toBe(false);
    } catch (error) {
      failure = error;
      await app
        ?.windows()[0]
        ?.screenshot({ path: "test-results/login-items-failure.png" })
        .catch(() => {});
    } finally {
      if (prepared) {
        try {
          if (!app) await launch();
          const cleanup = async () =>
            app!.evaluate(({ app }) => {
              app.setLoginItemSettings({
                type: "mainAppService",
                openAtLogin: false,
              });
              return app.getLoginItemSettings({ type: "mainAppService" });
            });
          let restored;
          try {
            restored = await cleanup();
          } catch {
            await app?.close().catch(() => {});
            await launch();
            restored = await cleanup();
          }
          evidence.push({ cleanup: restored });
          expect(restored.openAtLogin).toBe(false);
          expect(["enabled", "requires-approval"]).not.toContain(
            restored.status,
          );
        } catch (error) {
          cleanupErrors.push(String(error));
        }
      }
      await app
        ?.close()
        .catch((error: unknown) => cleanupErrors.push(String(error)));
      if (prepared) {
        try {
          execFileSync(lsregister, ["-u", bundle]);
        } catch (error) {
          cleanupErrors.push(String(error));
        }
      }
      try {
        await writeFile(
          "test-results/packaged-login-items.json",
          JSON.stringify(
            {
              identity,
              bundle,
              evidence,
              cleanupErrors,
              actualLogoutLogin: "Pending; not performed by automation",
            },
            null,
            2,
          ),
        );
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      // Retain the owned bundle if restoration failed, so its service can still
      // be unregistered on a follow-up instead of leaving a dangling login item.
      if (!cleanupErrors.length) {
        await rm(root, { recursive: true, force: true }).catch(
          (error: unknown) => cleanupErrors.push(String(error)),
        );
      }
    }
    if (failure) throw failure;
    if (cleanupErrors.length)
      throw new Error(`Login test cleanup failed: ${cleanupErrors.join("; ")}`);
  },
);
