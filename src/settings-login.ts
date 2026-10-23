import type { Settings } from "./shared/contract";
export function attachLoginSettings() {
  let loginState: Settings["login"] = {
    status: "unavailable",
    reason: "正在读取系统状态…",
  };
  const loginToggle =
    document.querySelector<HTMLInputElement>("#login-enabled")!;
  let loginBusy = false;
  const renderLogin = (login: Settings["login"]) => {
    loginState = login;
    loginToggle.checked = login.status === "enabled";
    loginToggle.disabled =
      loginBusy ||
      login.status === "unavailable" ||
      login.status === "requires-approval";
    document.querySelector("#login-status")!.textContent = {
      enabled: "已开启",
      disabled: "已关闭",
      "requires-approval":
        "等待批准：请在系统设置 → 通用 → 登录项中允许 Mosey。",
      unavailable: "开机启动不可用",
    }[login.status];
    const reason = document.querySelector<HTMLElement>("#login-reason")!;
    reason.hidden = !login.reason;
    reason.textContent = login.reason ?? "";
    const error = document.querySelector<HTMLElement>("#login-error")!;
    error.hidden = !login.error;
    error.textContent = login.error ?? "";
    const cancel = document.querySelector<HTMLButtonElement>("#login-cancel")!;
    cancel.hidden = login.status !== "requires-approval";
    cancel.disabled = loginBusy;
    const system = document.querySelector<HTMLButtonElement>("#login-system")!;
    system.hidden = login.status !== "requires-approval" && !login.error;
    system.disabled = loginBusy;
  };
  const loginAction = async (action: () => Promise<Settings>) => {
    if (loginBusy) return;
    loginBusy = true;
    renderLogin(loginState);
    try {
      renderLogin((await action()).login);
    } catch (error) {
      renderLogin({
        ...loginState,
        error: `操作失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      loginBusy = false;
      renderLogin(loginState);
    }
  };
  loginToggle.addEventListener("change", () => {
    const enabled = loginToggle.checked;
    void loginAction(() => window.moseySettings.setLoginLaunch(enabled));
  });
  document
    .querySelector("#login-cancel")!
    .addEventListener(
      "click",
      () => void loginAction(() => window.moseySettings.setLoginLaunch(false)),
    );
  document
    .querySelector("#login-system")!
    .addEventListener(
      "click",
      () => void loginAction(() => window.moseySettings.openLoginSettings()),
    );

  window.moseySettings.onChange((next) => renderLogin(next.login));
  renderLogin(loginState);
  void window.moseySettings
    .get()
    .then((next) => renderLogin(next.login))
    .catch((error) =>
      renderLogin({
        status: "unavailable",
        reason: `无法读取开机启动状态：${String(error)}`,
      }),
    );
}
