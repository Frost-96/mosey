# #14 实测记录（2026-10-20，进行中）

本记录属于独立探针，不代表 #8 攀爬或正式 Electron 应用通过。

## 已确认事实

宿主：macOS 27.0.1（26A434），arm64，Swift 6.4；单主屏 1470×956 点，2 倍缩放。探针通过当前 Codex 执行宿主启动；原始 JSONL 包含 PID、时间戳及可执行路径。没有申请或修改系统权限。

| 原始证据 | 操作与实际返回 | 结论边界 |
| --- | --- | --- |
| [host-baseline.jsonl](host-baseline.jsonl) | 桌面会话，底部 Dock、自动隐藏开启；找到 Dock，窗口枚举可用，AX 未授权且返回 -25211；无候选边缘 | 基线；没有视觉确认当时显隐状态，不能叫“隐藏场景通过” |
| [bottom-shown-setting.jsonl](bottom-shown-setting.jsonl) | 通过系统设置临时关闭自动隐藏后采集；CG 返回 1470×956 整屏 Dock 窗口，AX 仍为 -25211 | 不可当作实际 Dock 轮廓。仅设置与接口对照，未得到屏幕可视边缘对照 |
| [sandbox-unavailable-before-fix.jsonl](sandbox-unavailable-before-fix.jsonl) | 沙箱中无屏幕、无 Dock、窗口列表不可用 | 执行环境限制，不是 Dock 能力失败；采集时旧代码将其归入 AX 不可用，后续已独立标记 desktop_unavailable |

底部设置试验后，通过系统设置恢复自动隐藏开启，并读回为 1。位置、大小、放大设置未改变。两组桌面会话中屏幕录制预检为真，仅属于执行宿主；未用它采集屏幕，也不推断产品拥有授权。

系统 SDK 的 HIServices/AXError.h 将 -25211 定义为 kAXErrorAPIDisabled。该状态无法区分从未授权与用户拒绝；未实测授权后撤销。AXUIElement.h 说明消息超时只对指定对象生效，探针现已对每个查询对象设置超时。

## 研究与接入判断

- [NSScreen.visibleFrame](https://developer.apple.com/documentation/appkit/nsscreen/visibleframe) 是可用绘制区域；自动隐藏时也可能预留边界。它不提供 Dock 的动态宽度或图标轮廓。实测可用区域变化不能代替轮廓证据。
- [AXUIElementCopyAttributeValue](https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue) 是公开属性查询接口，不保证 Dock 暴露的 AXList 与可见背景或放大图标的顶部相同。候选覆盖线只能用于对照；本轮未授权时没有可用结果。
- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit) 是公开像素采集方向，需要用户屏幕录制授权；分割、遮挡、透明背景、缩放及延迟都需另行验证。本轮未运行此路线，不能称其可行或不可行。

建议：先在用户同意的 AX 权限下取得真实显隐、放大及左右位置对照，再决定是否接入原生桥接。独立 Swift 子进程可避免 Node ABI 耦合，但增加生命周期、stdio 协议、应用资源定位、签名和 TCC 身份复验成本；N-API 原生插件增加构建、Electron 适配和签名维护成本。两者均未选定；本票不引入守护程序或公共插件。

## 尚未完成

- 真实 Dock 出现、隐藏、宽度与放大变化的可视证据，以及候选线和真实可见边缘逐段对照。
- 左右位置的内侧边缘、显隐与避让几何验证。
- 授权状态下的 AX 观测，以及拒绝／撤销后的实际表现。
- 最终固定的开发版、打包 Electron 环境和显示矩阵复验。

当前只有可复现的负面基线，尚不足关闭 #14。不认定 AX 路线不可行，不取消 #8 攀爬，不引入固定边界降级。用户已同意手动授权后继续验证；等待其完成授权再更新本记录。
