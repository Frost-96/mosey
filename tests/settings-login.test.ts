import { test, expect } from "vitest";
import { mkdir } from "node:fs/promises";
import { closeSettings, openSettings } from "./support/settings";
import { createPetTestSession } from "./support/pet-session";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("login settings explain availability and follow system approval, failure and focus refresh", async () => {
  const session = await createPetTestSession({ dock: "empty" });
  const { app, pet } = await session.launch();
  const runtimeErrors: string[] = [];
  try {
    const settingsScriptsInPet = () =>
      session.run("settings-login:pet.evaluate", () =>
        pet.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .map((entry) => new URL(entry.name).pathname)
            .filter(
              (name) =>
                /\.(?:[jt]sx?)$/.test(name) && /settings|react/.test(name),
            ),
        ),
      );
    expect(await settingsScriptsInPet()).toEqual([]);
    app.on("window", (page) => {
      page.on("pageerror", (error) => runtimeErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") runtimeErrors.push(message.text());
      });
    });
    const settings = await openSettings(app, { run: session.run });
    const login = settings.getByRole("region", { name: "开机启动" });
    await session.run("settings-login:login.waitFor", () => login.waitFor());
    if (!packaged) {
      expect(
        await session.run("settings-login:login.textContent", () =>
          login.textContent(),
        ),
      ).toContain("打包后的 macOS 应用");
      expect(
        await session.run("settings-login:login.isDisabled", () =>
          login.getByRole("checkbox").isDisabled(),
        ),
      ).toBe(true);
    }
    expect(
      await session.run("settings-login:app.evaluate", () =>
        app.evaluate(({ Menu }) =>
          Menu.getApplicationMenu()!
            .items.find((item) => item.label === "Mosey")!
            .submenu!.items.map((item) => item.label),
        ),
      ),
    ).toContain("Launch at Login");
    // Controlled results at the OS boundary; all product paths remain real Electron UI/IPC.
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ app, shell }) => {
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
            openAtLogin:
              Reflect.get(globalThis, "loginTestStatus") === "enabled",
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
      }),
    );
    await expect
      .poll(() =>
        session.run("settings-login:login.isDisabled", () =>
          login.getByRole("checkbox").isDisabled(),
        ),
      )
      .toBe(false);
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()!
          .items.find((item) => item.label === "Mosey")!
          .submenu!.items.find((item) => item.label === "Launch at Login")!
          .click(),
      ),
    );
    await expect
      .poll(() =>
        session.run("settings-login:login.textContent", () =>
          login.textContent(),
        ),
      )
      .toContain("等待批准");
    expect(
      await session.run("settings-login:login.isChecked", () =>
        login.getByRole("checkbox").isChecked(),
      ),
    ).toBe(false);
    await session.run("settings-login:login.click", () =>
      login.getByRole("button", { name: "打开系统设置" }).click(),
    );
    expect(
      await session.run("settings-login:app.evaluate", () =>
        app.evaluate(() => Reflect.get(globalThis, "loginTestURL")),
      ),
    ).toBe("x-apple.systempreferences:com.apple.LoginItems-Settings.extension");
    await session.run("settings-login:login.click", () =>
      login.getByRole("button", { name: "取消待批准请求" }).click(),
    );
    await expect
      .poll(() =>
        session.run("settings-login:login.textContent", () =>
          login.textContent(),
        ),
      )
      .toContain("已关闭");
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(() => Reflect.set(globalThis, "loginTestFailure", true)),
    );
    await session.run("settings-login:login.click", () =>
      login.getByRole("checkbox").click(),
    );
    await expect
      .poll(() =>
        session.run("settings-login:login.textContent", () =>
          login.getByRole("alert").textContent(),
        ),
      )
      .toContain("controlled registration failure");
    expect(
      await session.run("settings-login:login.isChecked", () =>
        login.getByRole("checkbox").isChecked(),
      ),
    ).toBe(false);
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ BrowserWindow }) => {
        Reflect.set(globalThis, "loginTestStatus", "enabled");
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Mosey 设置")!
          .emit("focus");
      }),
    );
    await expect
      .poll(() =>
        session.run("settings-login:login.isChecked", () =>
          login.getByRole("checkbox").isChecked(),
        ),
      )
      .toBe(true);
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ app }) => {
        Reflect.set(globalThis, "loginTestReadFailure", true);
        app.emit("activate");
      }),
    );
    await expect
      .poll(() =>
        session.run("settings-login:login.textContent", () =>
          login.textContent(),
        ),
      )
      .toContain("controlled status read failure");
    expect(
      await session.run("settings-login:login.isDisabled", () =>
        login.getByRole("checkbox").isDisabled(),
      ),
    ).toBe(true);
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ app }) => {
        Reflect.set(globalThis, "loginTestReadFailure", false);
        Reflect.set(globalThis, "loginTestFailure", false);
        app.emit("activate");
      }),
    );
    await expect
      .poll(() =>
        session.run("settings-login:login.isDisabled", () =>
          login.getByRole("checkbox").isDisabled(),
        ),
      )
      .toBe(false);
    await session.run("settings-login:login.click", () =>
      login.getByRole("checkbox").click(),
    );
    await expect
      .poll(() =>
        session.run("settings-login:login.textContent", () =>
          login.textContent(),
        ),
      )
      .toContain("已关闭");
    expect(
      await session.run("settings-login:login.isVisible", () =>
        login.getByRole("alert").isVisible(),
      ),
    ).toBe(false);
    // Hold the IPC response while newer system notifications reach the UI.
    // A late transport failure must not replace the refreshed system result.
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ ipcMain }) => {
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
      }),
    );
    await session.run("settings-login:login.click", () =>
      login.getByRole("checkbox").click(),
    );
    await expect
      .poll(() =>
        session.run("settings-login:login.isDisabled", () =>
          login.getByRole("checkbox").isDisabled(),
        ),
      )
      .toBe(true);
    // Real pointer activation through the label must not submit again while
    // its checkbox is disabled (React checkbox changes are click-driven).
    await session.run("settings-login:login.click", () =>
      login.locator("label").click({ force: true }),
    );
    expect(
      await session.run("settings-login:app.evaluate", () =>
        app.evaluate(() => Reflect.get(globalThis, "loginPendingCalls")),
      ),
    ).toBe(1);
    await session.run("settings-login:settings.click", () =>
      settings.getByRole("button", { name: "大", exact: true }).click(),
    );
    await expect
      .poll(() =>
        session.run("settings-login:settings.textContent", () =>
          settings.locator("output").textContent(),
        ),
      )
      .toBe("240");
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ app }) => {
        Reflect.set(globalThis, "loginTestStatus", "enabled");
        app.emit("activate");
      }),
    );
    await expect
      .poll(() =>
        session.run("settings-login:login.isChecked", () =>
          login.getByRole("checkbox").isChecked(),
        ),
      )
      .toBe(true);
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(() => Reflect.get(globalThis, "rejectLoginRequest")()),
    );
    await expect
      .poll(() =>
        session.run("settings-login:login.isDisabled", () =>
          login.getByRole("checkbox").isDisabled(),
        ),
      )
      .toBe(false);
    expect(
      await session.run("settings-login:login.isVisible", () =>
        login.getByRole("alert").isVisible(),
      ),
    ).toBe(false);
    // A delayed successful response and delayed initial reads are also stale
    // after a newer notification, including across window close/reopen.
    const old = await session.run("settings-login:settings.evaluate", () =>
      settings.evaluate(() => window.moseySettings.get()),
    );
    await closeSettings(app, { run: session.run });
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ ipcMain }, old) => {
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
              Reflect.set(globalThis, "resolveLoginRequest", () =>
                resolve(old),
              );
            }),
        );
      }, old),
    );
    const reopened = await openSettings(app, {
      run: session.run,
      waitForInitialState: false,
    });
    const reopenedLogin = reopened.getByRole("region", { name: "开机启动" });
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ app }) => {
        Reflect.set(globalThis, "loginTestStatus", "not-registered");
        app.emit("activate");
      }),
    );
    await expect
      .poll(() =>
        session.run("settings-login:reopenedLogin.textContent", () =>
          reopenedLogin.textContent(),
        ),
      )
      .toContain("已关闭");
    await session.run("settings-login:reopenedLogin.click", () =>
      reopenedLogin.getByRole("checkbox").click(),
    );
    await expect
      .poll(() =>
        session.run("settings-login:reopenedLogin.isDisabled", () =>
          reopenedLogin.getByRole("checkbox").isDisabled(),
        ),
      )
      .toBe(true);
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ app }) => {
        Reflect.set(globalThis, "loginTestStatus", "requires-approval");
        app.emit("activate");
      }),
    );
    await expect
      .poll(() =>
        session.run("settings-login:reopenedLogin.textContent", () =>
          reopenedLogin.textContent(),
        ),
      )
      .toContain("等待批准");
    expect(
      await session.run("settings-login:reopenedLogin.isDisabled", () =>
        reopenedLogin
          .getByRole("button", { name: "取消待批准请求" })
          .isDisabled(),
      ),
    ).toBe(true);
    expect(
      await session.run("settings-login:reopenedLogin.isDisabled", () =>
        reopenedLogin
          .getByRole("button", { name: "打开系统设置" })
          .isDisabled(),
      ),
    ).toBe(true);
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(() => {
        Reflect.get(globalThis, "releaseLoginReads")();
        Reflect.get(globalThis, "resolveLoginRequest")();
      }),
    );
    await expect
      .poll(() =>
        session.run("settings-login:reopenedLogin.isEnabled", () =>
          reopenedLogin
            .getByRole("button", { name: "取消待批准请求" })
            .isEnabled(),
        ),
      )
      .toBe(true);
    expect(
      await session.run("settings-login:reopenedLogin.textContent", () =>
        reopenedLogin.textContent(),
      ),
    ).toContain("等待批准");
    expect(
      await session.run("settings-login:reopenedLogin.isChecked", () =>
        reopenedLogin.getByRole("checkbox").isChecked(),
      ),
    ).toBe(false);

    await session.run("settings-login:reopened.click", () =>
      reopened.getByRole("button", { name: "取消待批准请求" }).click(),
    );
    await expect
      .poll(() =>
        session.run("settings-login:reopenedLogin.isDisabled", () =>
          reopenedLogin
            .getByRole("button", { name: "取消待批准请求" })
            .isDisabled(),
        ),
      )
      .toBe(true);
    // pagehide exercises the same root disposal as a native window teardown,
    // but leaves the document observable while the old IPC result completes.
    await session.run("settings-login:reopened.evaluate", () =>
      reopened.evaluate(() => window.dispatchEvent(new Event("pagehide"))),
    );
    await expect
      .poll(() =>
        session.run("settings-login:reopenedLogin.count", () =>
          reopenedLogin.count(),
        ),
      )
      .toBe(0);
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ app }) => {
        Reflect.get(globalThis, "resolveLoginRequest")();
        app.emit("activate");
      }),
    );
    expect(
      await session.run("settings-login:reopened.count", () =>
        reopened.getByRole("region", { name: "开机启动" }).count(),
      ),
    ).toBe(0);
    await closeSettings(app, { run: session.run });
    await session.run("settings-login:app.evaluate", () =>
      app.evaluate(({ ipcMain }, old) => {
        Reflect.set(globalThis, "loginTestStatus", "enabled");
        ipcMain.removeHandler("settings:get");
        ipcMain.handle("settings:get", () => old);
      }, old),
    );
    const finalSettings = await openSettings(app, { run: session.run });
    await expect
      .poll(() =>
        session.run("settings-login:finalSettings.isChecked", () =>
          finalSettings.getByRole("checkbox").isChecked(),
        ),
      )
      .toBe(true);
    await session.run("settings-login:mkdir", () =>
      mkdir("test-results", { recursive: true }),
    );
    await session.run("settings-login:finalSettings.screenshot", () =>
      finalSettings.screenshot({
        fullPage: true,
        path: `test-results/settings-login-${packaged ? "packaged" : "development"}-controlled.png`,
      }),
    );
    expect(runtimeErrors).toEqual([]);
    expect(await settingsScriptsInPet()).toEqual([]);
    expect(
      await session.run("settings-login:pet.count", () =>
        pet.locator("canvas").count(),
      ),
    ).toBe(1);
    await session.quit();
  } catch (error) {
    console.error({ runtimeErrors });
    throw error;
  }
});
