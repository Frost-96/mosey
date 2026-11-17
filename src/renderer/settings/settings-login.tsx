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
  const unavailable = login.status === "unavailable";
  const reason = awaitingApproval
    ? "请在 系统设置 › 通用 › 登录项 中允许 Mosey。"
    : login.reason;
  // On and off are told by the switch itself; the status stays in the live
  // region for assistive technology and only the other states are shown.
  const quiet = !awaitingApproval && !unavailable && !login.error;
  return (
    <section aria-labelledby="login-heading">
      <h2 id="login-heading">开机启动</h2>
      <div className="card">
        <label className="switch-row">
          <span>登录后启动 Mosey</span>
          <input
            id="login-enabled"
            type="checkbox"
            role="switch"
            checked={login.status === "enabled"}
            disabled={busy || unavailable || awaitingApproval}
            onChange={(event) => setEnabled(event.currentTarget.checked)}
          />
        </label>
        <div
          className={quiet ? "login-detail visually-hidden" : "login-detail"}
          data-tone={awaitingApproval ? "warning" : undefined}
        >
          <p id="login-status" aria-live="polite">
            {
              {
                enabled: "已开启",
                disabled: "已关闭",
                "requires-approval": "等待批准",
                unavailable: "开机启动不可用",
              }[login.status]
            }
          </p>
          <p id="login-reason" className="hint" hidden={!reason}>
            {reason}
          </p>
          <p id="login-error" role="alert" hidden={!login.error}>
            {login.error}
          </p>
          <div className="actions" hidden={!awaitingApproval && !login.error}>
            <button
              id="login-system"
              className="primary"
              disabled={busy}
              onClick={openSystemSettings}
            >
              打开系统设置
            </button>
            <button
              id="login-cancel"
              hidden={!awaitingApproval}
              disabled={busy}
              onClick={() => setEnabled(false)}
            >
              取消请求
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
