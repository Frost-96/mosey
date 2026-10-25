import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { startForge } from "./support/forge";
import { openSettings } from "./support/settings";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("login settings explain availability and follow system approval, failure and focus refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-settings-login-"));
  let app: ElectronApplication | undefined;
  let stop: (() => Promise<void>) | undefined;
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
    await app.firstWindow();
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
    await mkdir("docs/validation", { recursive: true });
    await settings.screenshot({
      fullPage: true,
      path: `docs/validation/issue-33-${packaged ? "packaged" : "development"}-controlled-login.png`,
    });
  } finally {
    await app?.close();
    await stop?.();
    await rm(root, { recursive: true, force: true });
  }
});
