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

## 代码审查修正：取消消息绑定手势

审查发现，最初依据 dragging→其他展示状态释放捕获的实现存在队列竞态：用户松手并立即再次抓住后，旧 flutter 展示消息才抵达渲染器，可能错误取消新手势。相同的姿态推断也不能处理拖动阈值前的 resting→resting 取消。

新增真实 Electron 回归先 RED（39.45s）：保持真实活动鼠标指针，在单个繁忙的渲染器任务中通过公开 DOM PointerEvent 连续发送 release 和新 press，确保输入早于旧展示消息送达。旧实现使新指针捕获变成 false。这里控制的是外部输入排队，不注入行为状态或伪造应用 IPC，也不将定向输入解释为真实跨应用系统捕获证据。

修复改为主进程取消交互时发送带 `gestureId` 的专门消息，经 preload 的严格 Zod 校验后，渲染器只结束身份相同的手势。取消不再从姿态或可见性消息推断；主进程隐藏／重载的原有取消路径同样发送身份消息。正常松手后，延迟的旧展示消息不会释放新手势。监听器在 pagehide 清理。额外覆盖阈值前仅按住、未进入拖动的显示变化，要求其捕获也释放；原有隐藏中断和重载回归保留。

第一次修正运行已保留新捕获，但测试向上移动时窗口原本已经位于顶部 y=33，错误要求 y<-7。将新移动改为有空间的向下移动后，完整开发测试 GREEN（51.30s）。随后加入阈值前场景的完整运行，在到达新增场景前的既有捕获丢失用例中失败：期望地面 y=716，最后采样 y=706（34.66s）。没有该次逐帧事件记录，不能断言其根因；未扩大等待或修改该场景断言，以相同源码重跑并在下文记录最终结果。

审查修正后最终验证（包含阈值前场景）：同源完整开发 1x 通过（1 passed / 1 packaged-only skipped，53.66s）；开发 2x 通过（1 passed / 1 skipped，57.21s）；`pnpm package:mac` 重新打包成功；新产物 `pnpm test:packaged` 通过（2 passed，51.08s）。这些通过覆盖立即重抓、阈值前取消、隐藏中断、重载及原有恢复场景，不抹去前述中间失败，也不新增物理屏幕验证结论。
