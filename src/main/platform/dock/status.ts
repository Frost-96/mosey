// Dock runtime states. The runtime records and logs a code; menus present its
// wording, and tests read the code back instead of comparing wording.
const wording = {
  stopped: "已停止",
  stopping: "正在停止",
  checking: "正在检查屏幕录制权限",
  active: "运行中",
  "needs-permission": "需要屏幕录制权限",
  suspended: "Dock 暂停更新，等待恢复",
  updating: "正在更新 Dock 边缘",
  waiting: "等待 Dock 显示",
  unavailable: "暂不可用",
  "retry-required": "多次恢复失败，请重试",
  restarting: "Dock 无响应，正在重启",
  "heartbeat-lost": "Dock 捕获无响应",
  "display-changed": "显示器已变化",
  "protocol-invalid": "Dock 数据无效",
  "stderr-limit": "辅助程序输出异常",
  "helper-failed": "辅助程序无法启动",
  truncated: "Dock 数据不完整",
  ended: "Dock 捕获已结束",
} as const;

export type DockStatus = keyof typeof wording;

export const dockStatuses = Object.keys(wording) as DockStatus[];

export const dockStatusLabel = (status: DockStatus) =>
  `状态：${wording[status]}`;

// Tests and tools read the status menu item back as a code.
export const dockStatusCode = (label: string) =>
  dockStatuses.find((status) => dockStatusLabel(status) === label);

// States that only the user can resolve: missing permission or an exhausted
// recovery budget. Transient states recover on their own and stay quiet.
export const dockNeedsAttention = (status: DockStatus) =>
  status === "needs-permission" || status === "retry-required";
