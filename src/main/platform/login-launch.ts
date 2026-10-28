import { app, shell } from "electron";
import log from "electron-log/main";
import type { Settings } from "../../shared/contract";

// The operating system owns registration; both menu and settings read this result.
export class LoginLaunch {
  private error: string | undefined;
  read(): Settings["login"] {
    if (process.platform !== "darwin" || !app.isPackaged)
      return {
        status: "unavailable",
        reason: "开机启动仅适用于打包后的 macOS 应用。",
        error: this.error,
      };
    try {
      const actual = app.getLoginItemSettings({ type: "mainAppService" });
      if (actual.status === "requires-approval")
        return { status: "requires-approval", error: this.error };
      return {
        status:
          actual.status === "enabled" && actual.openAtLogin
            ? "enabled"
            : "disabled",
        error: this.error,
      };
    } catch (error) {
      log.warn("Unable to read login item settings", error);
      return {
        status: "unavailable",
        reason: `无法读取系统开机启动状态：${error instanceof Error ? error.message : String(error)}`,
        error: this.error,
      };
    }
  }
  setEnabled(openAtLogin: boolean) {
    this.error = undefined;
    if (this.read().status === "unavailable") return;
    try {
      app.setLoginItemSettings({ type: "mainAppService", openAtLogin });
      const actual = this.read();
      const registered =
        actual.status === "enabled" || actual.status === "requires-approval";
      if (actual.status === "unavailable" || registered !== openAtLogin)
        this.error = "系统未完成开机启动更改，请重试或检查系统设置。";
    } catch (error) {
      this.error = `开机启动更改失败：${error instanceof Error ? error.message : String(error)}`;
      log.warn("Unable to change login item settings", error);
    }
  }
  async openSettings() {
    try {
      if (process.platform !== "darwin")
        throw new Error("此平台不支持 macOS 系统设置。");
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
      );
    } catch (error) {
      this.error = `无法打开系统设置：${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
