import { test, expect } from "vitest";
import {
  _electron as electron,
  type Page,
  type ElectronApplication,
} from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openSettings } from "./support/settings";

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
    let settings: Page | undefined;
    let prepared = false;
    let failure: unknown;
    const cleanupErrors: string[] = [];
    const evidence: unknown[] = [];
    const read = async () => {
      const result = await app!.evaluate(({ app }) => ({
        system: app.getLoginItemSettings({ type: "mainAppService" }),
        appPath: app.getAppPath(),
        executable: process.execPath,
      }));
      const login = settings!.getByRole("region", { name: "开机启动" });
      // Unchecked also matches the initial loading view. Wait for both fields
      // together so a pending read cannot masquerade as confirmed system state.
      await expect
        .poll(() =>
          login.getByRole("checkbox").evaluate((input: HTMLInputElement) => ({
            checked: input.checked,
            disabled: input.disabled,
          })),
        )
        .toEqual({
          checked:
            result.system.status === "enabled" && result.system.openAtLogin,
          disabled: result.system.status === "requires-approval",
        });
      if (result.system.status === "requires-approval")
        await expect.poll(() => login.textContent()).toContain("等待批准");
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
      settings = await openSettings(app);
    };
    const click = async () => {
      const previous = await app!.evaluate(
        ({ app }) =>
          app.getLoginItemSettings({ type: "mainAppService" }).status,
      );
      const pet = app!
        .windows()
        .find((page) => !new URL(page.url()).searchParams.has("settings"))!;
      await app!.evaluate(({ Menu }) => {
        // Keep native tracking deterministic; the real system service is untouched.
        Menu.prototype.popup = function (options) {
          Reflect.set(globalThis, "loginBodyMenu", this);
          Reflect.set(this, "trackingCallback", options?.callback);
        };
      });
      // Settings readiness can precede pet atlas decoding and the first frame.
      // Wait for the same opaque body area that the click must actually hit.
      await pet.waitForLoadState("load");
      const body = await pet.waitForFunction(
        () => {
          const canvas = document.querySelector("canvas")!;
          const { data, width, height } = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height);
          for (let y = Math.floor(height * 0.65); y < height - 8; y++)
            for (let x = Math.floor(width * 0.4); x < width - 8; x++)
              if (
                [0, -4, 4].every((dy) =>
                  [0, -4, 4].every(
                    (dx) => data[((y + dy) * width + x + dx) * 4 + 3]! > 250,
                  ),
                )
              )
                return {
                  x: (x + 0.5) / devicePixelRatio,
                  y: (y + 0.5) / devicePixelRatio,
                };
          return undefined;
        },
        undefined,
        { timeout: 10000 },
      );
      const point = (await body.jsonValue())!;
      await body.dispose();
      await pet.mouse.click(point.x, point.y, { button: "right" });
      await expect
        .poll(() =>
          app!.evaluate(() => !!Reflect.get(globalThis, "loginBodyMenu")),
        )
        .toBe(true);
      const checked = await app!.evaluate(
        () =>
          Reflect.get(globalThis, "loginBodyMenu").items.find(
            (item: { label: string }) => item.label === "Launch at Login",
          ).checked,
      );
      expect(checked).toBe(previous === "enabled");
      await app!.evaluate(() => {
        const menu = Reflect.get(globalThis, "loginBodyMenu");
        menu.items
          .find((item: { label: string }) => item.label === "Launch at Login")
          .click();
        Reflect.get(menu, "trackingCallback")?.();
        Reflect.set(globalThis, "loginBodyMenu", undefined);
      });
      await expect
        .poll(() =>
          app!.evaluate(
            ({ app }) =>
              app.getLoginItemSettings({ type: "mainAppService" }).status,
          ),
        )
        .not.toBe(previous);
    };
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
      // Prove explicit Off through settings before another ordinary Quit.
      await click();
      const reenabled = await read();
      if (reenabled.system.status === "requires-approval") {
        await settings!.getByRole("button", { name: "取消待批准请求" }).click();
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
