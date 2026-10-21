# Issue #10：用户明确控制开机启动

2026-10-21，macOS 27.0.1 (26A434)，Apple Silicon，Electron 44.9.1。

## 实现范围

菜单栏的 Launch at Login 复选框读取 macOS `mainAppService`，仅在系统状态为 `enabled` 且 `openAtLogin` 为真时勾选。启动和普通退出均不写登录设置，不在 JSON 保存另一份偏好。设置写入后立即重新读取；`requires-approval` 显示系统设置说明并允许取消待批准请求，读取或写入失败显示说明，不乐观勾选。

托盘采用明确的左／右键打开流程，在每次 `popUpContextMenu` 前重新读取系统状态，避免依赖 macOS 缓存原生 context menu 的预打开事件。应用 activate 时也刷新应用菜单。开发运行禁用写入，以免把 Electron 开发程序注册为登录项。打包版本使用当前 `.app` 的 main app service，不指定开发可执行文件路径。

## 已执行的验证

测试边界沿用用户已确认的整应用外部行为：Vitest 驱动真实 Playwright Electron，菜单和真实操作系统 API；不直接测试行为模块内部状态。

- RED：增加菜单存在／系统状态一致的断言后，开发测试失败于 `loginMenu.exists`（期望 true，实际 false）。实现后整应用开发回归通过。
- RED：真实新身份应用的 macOS 状态可为 `not-found`，但仍能成功注册。新安装菜单不应据此声称不可用的断言失败于旧提示 `Login launch unavailable: app service not found`。移除该误导提示后，真实原生测试通过。
- `pnpm check`：类型检查、ESLint 和格式检查通过。
- `pnpm package:mac`：arm64 打包成功。
- `pnpm test:dev`：真实开发应用通过（1 passed、2 skipped），包含单实例、交互、原生辅助进程退出及普通菜单退出回归。
- `pnpm test:packaged`：3 项全部通过（44.33 秒），包含无 inspector 干净启动、完整应用回归与离线原生登录项生命周期。加强失败清理后的原生单项再次通过（3.66 秒）。
- 原生登录项测试：复制 `.app` 到独立目录，分配唯一 CFBundleIdentifier 和签名 identifier，临时注册 LaunchServices；只修改这个测试身份自己的登录项。验证新身份默认关闭、产品菜单开启、普通 Quit／重新启动仍开启、直接修改操作系统设置后 activate 刷新、产品菜单关闭、普通 Quit／重启后仍关闭。最后读取确认 `not-registered`／`openAtLogin=false`，并删除临时应用／LaunchServices 注册。
- 原生测试在 Chromium offline 模式运行；这不等同于断开整台机器的网络。

测试统一使用独立 `--user-data-dir`；第二次启动复用同一测试 profile 来验证真实单实例。未终止其他聊天的应用。

## 诊断过程及边界

原生测试初期报告 `not-found`。独立 Swift 探针能够注册／注销（status 3 → 1 → 0）；最终查明测试先手动反转 `checked`，而 Electron `MenuItem.click()` 又反转了一次，实际发送了关闭请求。移除测试中的重复反转后，真实 Electron 注册成功；没有新增产品原生桥接。另修复 Playwright 连接关闭后读取 `app.process()` 的测试错误，先缓存 ChildProcess，并加强失败后的注销清理。

早期一次完整打包运行的无 inspector 启动报告 `sandbox_extension_issue_file_to_process ... Operation not permitted` 并退出。增加独立启动 profile／重新打包后的干净启动单项通过；不据此断言 EPERM 的具体根因。

## 尚未完成的登录验收

**未注销、未重启机器，实际 logout/login 验收仍待执行。系统属性读回与普通应用重启不代替该验收。Issue #10 不能凭本文自动宣称全部验收完成。**

在最终交付位置运行最终 `.app`，由用户开启登录启动并处理系统批准；记录系统登录项列表和 `.app` 位置。实际退出账户／重新登录后确认自动启动，记录本次 `wasOpenedAtLogin`、进程路径及单实例；再关闭开关并实际再次登录，确认不启动。普通退出不应撤销已选择的登录行为。最后恢复用户希望保留的设置。

原生属性读回证据保存在 [issue-10-login-items.json](issue-10-login-items.json)，其中临时路径与身份仅用于测试，不是最终安装位置，也不是登录会话证据。
