import type { Settings } from "../../shared/contract";

interface LoginSettingsProps {
  login: Settings["login"];
  busy: boolean;
  setEnabled(enabled: boolean): void;
  openSystemSettings(): void;
}
export function LoginSettings({
  login,
  busy,
  setEnabled,
  openSystemSettings,
}: LoginSettingsProps) {
  const awaitingApproval = login.status === "requires-approval";
  return (
    <section aria-labelledby="login-heading">
      <h2 id="login-heading">开机启动</h2>
      <label>
        <input
          id="login-enabled"
          type="checkbox"
          checked={login.status === "enabled"}
          disabled={busy || login.status === "unavailable" || awaitingApproval}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
        />{" "}
        登录后启动 Mosey
      </label>
      <p id="login-status" aria-live="polite">
        {
          {
            enabled: "已开启",
            disabled: "已关闭",
            "requires-approval":
              "等待批准：请在系统设置 → 通用 → 登录项中允许 Mosey。",
            unavailable: "开机启动不可用",
          }[login.status]
        }
      </p>
      <p id="login-reason" className="hint" hidden={!login.reason}>
        {login.reason}
      </p>
      <p id="login-error" role="alert" hidden={!login.error}>
        {login.error}
      </p>
      <button
        id="login-cancel"
        hidden={!awaitingApproval}
        disabled={busy}
        onClick={() => setEnabled(false)}
      >
        取消待批准请求
      </button>{" "}
      <button
        id="login-system"
        hidden={!awaitingApproval && !login.error}
        disabled={busy}
        onClick={openSystemSettings}
      >
        打开系统设置
      </button>
    </section>
  );
}
