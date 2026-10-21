# #7 主屏变化恢复

2026-10-21，macOS 27.0.1（26A434），Apple Silicon，Electron 44.9.1。验收边界沿用真实 Electron 整应用：公开输入、Canvas 画面、浏览器 Pointer Capture 和实际 BrowserWindow 位置。没有用普通浏览器代替应用，也没有检查行为状态机内部状态。

## 修改与红绿证据

#4 已经监听 `display-metrics-changed`、`display-added`、`display-removed`：取消主进程手势和下落，重置待机，按当前主屏 workArea 约束窗口并贴地。#7 保留这条实现，没有另造恢复模块、跨屏拖动或显示器选择设置。新增整应用场景检验该恢复路径，并修复两处此前未覆盖的问题。

第一轮 RED：通过真实 Electron 页面的 CDP `Emulation.setDeviceMetricsOverride` 将 DPR 从 1 改为 2，页面实际报告 DPR=2，Canvas 却仍为 240×240，期望为 480×480；完整开发测试 6.95s 在该断言失败。原因是渲染器仅启动时读取 DPR。修复为每次可见绘制检查 DPR，变化时重建 backing store、重设变换并重绘当前素材帧。GREEN：完整开发测试通过（42.62s）。后续完整 2x 测试也检验 2→1→2 的恢复。

第二轮 RED：真实输入启动拖动后，通过 Electron screen 边界发出屏幕变化事件，主进程回到底部，但 Canvas 的公开 `hasPointerCapture(pointerId)` 在超时后仍为 true（39.67s 失败）。主进程取消手势没有结束渲染器的浏览器捕获。修复为展示状态离开 dragging 时结束本地手势、释放捕获；旧 move/release 仍由主进程忽略。GREEN：完整开发测试通过（41.81s）。

## 自动化覆盖

后续整应用场景在 Electron screen 外部边界临时提供一个主屏 id 和向内缩小、原点偏移 (40,40) 的 workArea，并发出相应事件，随后立即还原真实 screen getter。只注入操作系统显示拓扑刺激；真实窗口移动、渲染、IPC、Pointer Capture、动画及后续输入都保留。

- 待机、拖动：display-metrics-changed。
- 扑腾：display-added；下落：display-removed。
- 断言实际窗口在新主屏有效区域内贴地、尺寸仍为 240×240、保持显示、画面回待机。
- 拖动中的屏幕变化释放浏览器捕获；旧移动和释放不会再移动窗口或恢复下落。
- 每种阶段恢复后都重新抓起可见身体，随后松手回到真实主屏地面，覆盖新坐标下素材与命中更新。
- 暂时隐藏窗口后发出 display-removed，窗口仍隐藏；明确显示后恢复待机。当前分支没有手动隐藏菜单或持久化隐藏意图，因此此项只证明系统隐藏状态，不宣称完成未来设置功能的联合回归。
- 原有极端指针位置场景继续检验窗口不跨出当前主屏。

DPR 用例是 CDP 外部显示缩放模拟；screen 事件和 workArea 用例是外部边界注入。它们都不是物理显示器切换、系统布局调整或实际拔屏证据。原点偏移只覆盖正向非零原点，没有验证负坐标显示布局。

测试启动使用临时 user-data-dir，重复启动用相同目录检查单实例；普通打包启动也隔离目录，不加入 inspector。首次未隔离运行被已有 Mosey 单实例影响而提前退出，不是功能 RED；没有终止用户或其他任务拥有的应用。

## 本机真实显示信息

[未附加缩放参数的打包应用记录](issue-7-display-snapshot.json) 由真实 Electron `screen.getAllDisplays()` / `getPrimaryDisplay()` 获取：当时 Electron 检测到一块内建视网膜显示器，id=1，主屏 bounds=(0,0,1470,956)，workArea=(0,33,1470,923)，scaleFactor=2。宠物初始实际 bounds=(615,716,240,240)，底部为 956，与当时 workArea 底部一致。该记录只描述采样时刻的布局；不从 GPU 型号或 system_profiler 缺失字段推断显示器数量。

没有可操控的外接屏切换／拔插设备证据。以下保留未验证：真实主屏切换、外接屏拔出、系统设置修改布局、不同物理缩放之间的迁移，以及负坐标布局。手动隐藏功能接入后的联合场景也未验证。这些限制不以注入用例通过替代。

## 最终验证

- `pnpm check`：通过。
- `pnpm test:dev`（1x）：1 passed / 1 packaged-only skipped，49.95s；包含完整恢复场景。
- `MOSEY_TEST_SCALE_FACTOR=2 pnpm test:dev`：1 passed / 1 packaged-only skipped，51.90s；包含完整恢复场景和 2→1→2 DPR 变化。
- `pnpm package:mac`：成功生成 `out/Mosey-darwin-arm64/Mosey.app`。
- `pnpm test:packaged`（1x）：2 passed，46.98s；含无 inspector 的隔离目录普通启动、完整恢复与既有交互／退出回归。

定向输入通过仍不等于真实跨应用系统输入、动态观感或物理显示器热插拔通过。
