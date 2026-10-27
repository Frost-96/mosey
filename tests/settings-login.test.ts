import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { startForge } from "./support/forge";
import { closeSettings, openSettings } from "./support/settings";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("login settings explain availability and follow system approval, failure and focus refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-settings-login-"));
  let app: ElectronApplication | undefined;
  let stop: (() => Promise<void>) | undefined;
  const runtimeErrors: string[] = [];
  try {
    if (!packaged) stop = await startForge();
    else
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [`--user-data-dir=${path.join(root, "profile")}`],
          }
        : { args: [".", `--user-data-dir=${path.join(root, "profile")}`] },
    );
    const pet = await app.firstWindow();
    const settingsScriptsInPet = () =>
      pet.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .map((entry) => new URL(entry.name).pathname)
          .filter(
            (name) =>
              /\.(?:[jt]sx?)$/.test(name) && /settings|react/.test(name),
          ),
      );
    expect(await settingsScriptsInPet()).toEqual([]);
    app.on("window", (page) => {
      page.on("pageerror", (error) => runtimeErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") runtimeErrors.push(message.text());
      });
    });
    const settings = await openSettings(app);
    const login = settings.getByRole("region", { name: "开机启动" });
    await login.waitFor();
    if (!packaged) {
      expect(await login.textContent()).toContain("打包后的 macOS 应用");
      expect(await login.getByRole("checkbox").isDisabled()).toBe(true);
    }
    expect(
      await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()!
          .items.find((item) => item.label === "Mosey")!
          .submenu!.items.map((item) => item.label),
      ),
    ).toContain("Launch at Login");
    // Controlled results at the OS boundary; all product paths remain real Electron UI/IPC.
    await app.evaluate(({ app, shell }) => {
      Object.defineProperty(app, "isPackaged", {
        value: true,
        configurable: true,
      });
      Reflect.set(globalThis, "loginTestStatus", "not-registered");
      Reflect.set(globalThis, "loginTestFailure", false);
      app.getLoginItemSettings = () => {
        if (Reflect.get(globalThis, "loginTestReadFailure"))
          throw new Error("controlled status read failure");
        return {
          status: Reflect.get(globalThis, "loginTestStatus"),
          openAtLogin: Reflect.get(globalThis, "loginTestStatus") === "enabled",
          openAsHidden: false,
          wasOpenedAtLogin: false,
          wasOpenedAsHidden: false,
          restoreState: false,
          executableWillLaunchAtLogin: false,
          launchItems: [],
        };
      };
      app.setLoginItemSettings = (value) => {
        if (Reflect.get(globalThis, "loginTestFailure"))
          throw new Error("controlled registration failure");
        Reflect.set(
          globalThis,
          "loginTestStatus",
          value.openAtLogin ? "requires-approval" : "not-registered",
        );
      };
      shell.openExternal = async (url) => {
        Reflect.set(globalThis, "loginTestURL", url);
      };
      app.emit("activate");
    });
    await expect
      .poll(() => login.getByRole("checkbox").isDisabled())
      .toBe(false);
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items.find((item) => item.label === "Mosey")!
        .submenu!.items.find((item) => item.label === "Launch at Login")!
        .click(),
    );
    await expect.poll(() => login.textContent()).toContain("等待批准");
    expect(await login.getByRole("checkbox").isChecked()).toBe(false);
    await login.getByRole("button", { name: "打开系统设置" }).click();
    expect(
      await app.evaluate(() => Reflect.get(globalThis, "loginTestURL")),
    ).toBe("x-apple.systempreferences:com.apple.LoginItems-Settings.extension");
    await login.getByRole("button", { name: "取消待批准请求" }).click();
    await expect.poll(() => login.textContent()).toContain("已关闭");
    await app.evaluate(() => Reflect.set(globalThis, "loginTestFailure", true));
    await login.getByRole("checkbox").click();
    await expect
      .poll(() => login.getByRole("alert").textContent())
      .toContain("controlled registration failure");
    expect(await login.getByRole("checkbox").isChecked()).toBe(false);
    await app.evaluate(({ BrowserWindow }) => {
      Reflect.set(globalThis, "loginTestStatus", "enabled");
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Mosey 设置")!
        .emit("focus");
    });
    await expect.poll(() => login.getByRole("checkbox").isChecked()).toBe(true);
    await app.evaluate(({ app }) => {
      Reflect.set(globalThis, "loginTestReadFailure", true);
      app.emit("activate");
    });
    await expect
      .poll(() => login.textContent())
      .toContain("controlled status read failure");
    expect(await login.getByRole("checkbox").isDisabled()).toBe(true);
    await app.evaluate(({ app }) => {
      Reflect.set(globalThis, "loginTestReadFailure", false);
      Reflect.set(globalThis, "loginTestFailure", false);
      app.emit("activate");
    });
    await expect
      .poll(() => login.getByRole("checkbox").isDisabled())
      .toBe(false);
    await login.getByRole("checkbox").click();
    await expect.poll(() => login.textContent()).toContain("已关闭");
    expect(await login.getByRole("alert").isVisible()).toBe(false);
    // Hold the IPC response while newer system notifications reach the UI.
    // A late transport failure must not replace the refreshed system result.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("settings:login-launch");
      ipcMain.handle("settings:login-launch", () => {
        Reflect.set(
          globalThis,
          "loginPendingCalls",
          (Reflect.get(globalThis, "loginPendingCalls") ?? 0) + 1,
        );
        return new Promise((_resolve, reject) => {
          Reflect.set(globalThis, "rejectLoginRequest", () =>
            reject(new Error("obsolete transport failure")),
          );
        });
      });
    });
    await login.getByRole("checkbox").click();
    await expect
      .poll(() => login.getByRole("checkbox").isDisabled())
      .toBe(true);
    // Real pointer activation through the label must not submit again while
    // its checkbox is disabled (React checkbox changes are click-driven).
    await login.locator("label").click({ force: true });
    expect(
      await app.evaluate(() => Reflect.get(globalThis, "loginPendingCalls")),
    ).toBe(1);
    await settings.getByRole("button", { name: "大", exact: true }).click();
    await expect
      .poll(() => settings.locator("output").textContent())
      .toBe("240");
    await app.evaluate(({ app }) => {
      Reflect.set(globalThis, "loginTestStatus", "enabled");
      app.emit("activate");
    });
    await expect.poll(() => login.getByRole("checkbox").isChecked()).toBe(true);
    await app.evaluate(() => Reflect.get(globalThis, "rejectLoginRequest")());
    await expect
      .poll(() => login.getByRole("checkbox").isDisabled())
      .toBe(false);
    expect(await login.getByRole("alert").isVisible()).toBe(false);
    // A delayed successful response and delayed initial reads are also stale
    // after a newer notification, including across window close/reopen.
    const old = await settings.evaluate(() => window.moseySettings.get());
    await closeSettings(app);
    await app.evaluate(({ ipcMain }, old) => {
      const reads: ((value: typeof old) => void)[] = [];
      ipcMain.removeHandler("settings:get");
      ipcMain.handle(
        "settings:get",
        () => new Promise((resolve) => reads.push(resolve)),
      );
      Reflect.set(globalThis, "releaseLoginReads", () => {
        for (const resolve of reads.splice(0)) resolve(old);
      });
      ipcMain.removeHandler("settings:login-launch");
      ipcMain.handle(
        "settings:login-launch",
        () =>
          new Promise((resolve) => {
            Reflect.set(globalThis, "resolveLoginRequest", () => resolve(old));
          }),
      );
    }, old);
    const reopened = await openSettings(app);
    const reopenedLogin = reopened.getByRole("region", { name: "开机启动" });
    await app.evaluate(({ app }) => {
      Reflect.set(globalThis, "loginTestStatus", "not-registered");
      app.emit("activate");
    });
    await expect.poll(() => reopenedLogin.textContent()).toContain("已关闭");
    await reopenedLogin.getByRole("checkbox").click();
    await expect
      .poll(() => reopenedLogin.getByRole("checkbox").isDisabled())
      .toBe(true);
    await app.evaluate(({ app }) => {
      Reflect.set(globalThis, "loginTestStatus", "requires-approval");
      app.emit("activate");
    });
    await expect.poll(() => reopenedLogin.textContent()).toContain("等待批准");
    expect(
      await reopenedLogin
        .getByRole("button", { name: "取消待批准请求" })
        .isDisabled(),
    ).toBe(true);
    expect(
      await reopenedLogin
        .getByRole("button", { name: "打开系统设置" })
        .isDisabled(),
    ).toBe(true);
    await app.evaluate(() => {
      Reflect.get(globalThis, "releaseLoginReads")();
      Reflect.get(globalThis, "resolveLoginRequest")();
    });
    await expect
      .poll(() =>
        reopenedLogin
          .getByRole("button", { name: "取消待批准请求" })
          .isEnabled(),
      )
      .toBe(true);
    expect(await reopenedLogin.textContent()).toContain("等待批准");
    expect(await reopenedLogin.getByRole("checkbox").isChecked()).toBe(false);

    await reopened.getByRole("button", { name: "取消待批准请求" }).click();
    await expect
      .poll(() =>
        reopenedLogin
          .getByRole("button", { name: "取消待批准请求" })
          .isDisabled(),
      )
      .toBe(true);
    // pagehide exercises the same root disposal as a native window teardown,
    // but leaves the document observable while the old IPC result completes.
    await reopened.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect.poll(() => reopenedLogin.count()).toBe(0);
    await app.evaluate(({ app }) => {
      Reflect.get(globalThis, "resolveLoginRequest")();
      app.emit("activate");
    });
    expect(
      await reopened.getByRole("region", { name: "开机启动" }).count(),
    ).toBe(0);
    await closeSettings(app);
    await app.evaluate(({ ipcMain }, old) => {
      Reflect.set(globalThis, "loginTestStatus", "enabled");
      ipcMain.removeHandler("settings:get");
      ipcMain.handle("settings:get", () => old);
    }, old);
    const finalSettings = await openSettings(app);
    await expect
      .poll(() => finalSettings.getByRole("checkbox").isChecked())
      .toBe(true);
    await mkdir("test-results", { recursive: true });
    await finalSettings.screenshot({
      fullPage: true,
      path: `test-results/settings-login-${packaged ? "packaged" : "development"}-controlled.png`,
    });
    expect(runtimeErrors).toEqual([]);
    expect(await settingsScriptsInPet()).toEqual([]);
    expect(await pet.locator("canvas").count()).toBe(1);
  } catch (error) {
    console.error({ runtimeErrors });
    throw error;
  } finally {
    await app?.close();
    await stop?.();
    await rm(root, { recursive: true, force: true });
  }
});
