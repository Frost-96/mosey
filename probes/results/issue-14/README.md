# #14 实测记录（2026-10-20）

本记录属于独立探针，不代表 #8 攀爬或正式 Electron 应用通过。

## 已确认事实

宿主：macOS 27.0.1（26A434），arm64，Swift 6.4；单主屏 1470×956 点，2 倍缩放。探针通过当前 Codex 执行宿主启动；原始 JSONL 包含 PID、时间戳及可执行路径。以下三份初始记录采集时未申请或修改系统权限；之后用户手动开启辅助功能权限，代理没有操作权限开关。

| 原始证据 | 操作与实际返回 | 结论边界 |
| --- | --- | --- |
| [host-baseline.jsonl](host-baseline.jsonl) | 桌面会话，底部 Dock、自动隐藏开启；找到 Dock，窗口枚举可用，AX 未授权且返回 -25211；无候选边缘 | 基线；没有视觉确认当时显隐状态，不能叫“隐藏场景通过” |
| [bottom-shown-setting.jsonl](bottom-shown-setting.jsonl) | 通过系统设置临时关闭自动隐藏后采集；CG 返回 1470×956 整屏 Dock 窗口，AX 仍为 -25211 | 不可当作实际 Dock 轮廓。仅设置与接口对照，未得到屏幕可视边缘对照 |
| [sandbox-unavailable-before-fix.jsonl](sandbox-unavailable-before-fix.jsonl) | 沙箱中无屏幕、无 Dock、窗口列表不可用 | 执行环境限制，不是 Dock 能力失败；采集时旧代码将其归入 AX 不可用，后续已独立标记 desktop_unavailable |

底部设置试验后，通过系统设置恢复自动隐藏开启，并读回为 1。位置、大小、放大设置未改变。两组桌面会话中屏幕录制预检为真，仅属于执行宿主；未用它采集屏幕，也不推断产品拥有授权。

三份 JSONL 均采集自审查修复前的 a0e5be5 探针，原样保留。旧版 environment.coordinateSpace 文本未区分屏幕字段：screens.frame 与 visibleFrameDiagnosticOnly 实际为 AppKit 左下原点；AX/CG 样本为 CoreGraphics 左上原点。后续 8890caf 已分别标明并补充 display ID，不用旧标注推断多屏几何。

系统 SDK 的 HIServices/AXError.h 将 -25211 定义为 kAXErrorAPIDisabled。该状态无法区分从未授权与用户拒绝；未实测授权后撤销。AXUIElement.h 说明消息超时只对指定对象生效，探针现已对每个查询对象设置超时。

## 研究与接入判断

- [NSScreen.visibleFrame](https://developer.apple.com/documentation/appkit/nsscreen/visibleframe) 是可用绘制区域；自动隐藏时也可能预留边界。它不提供 Dock 的动态宽度或图标轮廓。实测可用区域变化不能代替轮廓证据。
- [AXUIElementCopyAttributeValue](https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue) 是公开属性查询接口，不保证 Dock 暴露的 AXList 与可见背景或放大图标的顶部相同。候选覆盖线只能用于对照；本轮未授权时没有可用结果。
- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit) 是公开像素采集方向，需要用户屏幕录制授权。本轮运行了其窗口元数据查询，像素取得则使用用户另行允许的系统 `screencapture`，该阶段尚未运行 SCK 实时流。后续已实测独立窗口实时流及独立.app身份，见[实时试验](live/README.md)；不同阶段不能混为同一次测量。

独立 Swift 子进程可避免 Node ABI 耦合，但增加生命周期、stdio 协议、应用资源定位、签名和 TCC 身份复验成本；N-API 原生插件增加构建、Electron 适配和签名维护成本。两者均未选定；本票不引入守护程序或公共插件。授权后的具体接入建议见下文。

## 用户授权后的复验

用户于本次对话明确告知辅助功能权限已开启并要求继续。新进程实际报告 `accessibilityTrusted=true`、`dockAXError=0`，不是仅依据用户报告推断。屏幕、系统与缩放不变；仍不代表打包 Electron 应用具有此权限。

| 原始记录 | 样本与实际观察 |
| --- | --- |
| [authorized-baseline.jsonl](authorized-baseline.jsonl) | 5 次采样；AXList 为 `(146,956,1178,79)`，位于屏幕底部之外，无候选。初始基线未同时截屏。 |
| [authorized-shown.jsonl](authorized-shown.jsonl) | 108 次采样；实际显示状态下 AXList 为 `(146,867,1178,79)`，底部距屏幕边缘 10 点。旧版要求距离小于 8 点，误过滤所有候选。 |
| [authorized-left-before-filter-fix.jsonl](authorized-left-before-filter-fix.jsonl)、[authorized-right-before-filter-fix.jsonl](authorized-right-before-filter-fix.jsonl) | 各 5 次采样；左右列表为 `(10,70,58,850)` 与 `(1402,70,58,850)`；同样暴露 10 点浮动间隙导致的筛选误判。 |
| [authorized-bottom-overlay.jsonl](authorized-bottom-overlay.jsonl) | 修复后 87 次采样均有候选，仍为 `supportEdge:null`。本地截图实际显示底部 Dock 与橙色线；线位于 AX 容器顶部，不能认作精确像素轮廓。 |
| [authorized-magnification.jsonl](authorized-magnification.jsonl) | 用户手动扫过图标；523 次采样中 522 次有候选，1 次因遍历不完整而取消。列表宽度 1178–1244 点，顶部始终 y=867；用户报告线没有向上顶而是向旁边移动。单个 AXDockItem 顶部约 855–872 点、高度约 79–96 点，提示单图标矩形值得进一步对照，不能将 AXList 的失败推导为整个 AX 路线失败。 |
| [authorized-left-overlay.jsonl](authorized-left-overlay.jsonl)、[authorized-right-overlay.jsonl](authorized-right-overlay.jsonl) | 各 35 次采样均有候选；本地截图确认竖线位于真实侧边 Dock 的内侧附近，但不是像素轮廓精确验收，不实现攀爬或宠物避让。 |
| [authorized-hide-transition.jsonl](authorized-hide-transition.jsonl) | 87 次采样，19 次有候选；恢复自动隐藏后，约第 4.48 秒列表移至 y=923，候选取消；约第 4.71 秒移至 y=956。随后本地截图确认 Dock 与橙色线均消失。记录标签 hidden 是整段场景标签，不表示前 19 次已经隐藏。 |

上述筛选修复见 `29a9ee8`：只有完整位于主屏、靠近配置侧边且树遍历完整的唯一列表才产生候选；距离阈值是实验启发式，不是可见性定理。所有坐标均为 CoreGraphics 点，元组顺序为 x、y、width、height。

用户明确允许以系统 `screencapture` 保存本地截图，同时要求不上传。图片没有加入 Git，也不附到 GitHub。截图中的其他桌面内容不用于本结论。第一段橙色线放大截图未捕获到持续悬停时刻；其证据是 AX 时间序列与用户观察。之后青色单图标诊断及隔离截图轮次实际捕获到悬停帧，不能将不同轮次混为同一次同步测量。

## 单图标语义矩形与像素路线

`7d745b14` 增加可选青色逐图标线。[authorized-item-magnification.jsonl](authorized-item-magnification.jsonl) 是该轮原始观测。用户再次扫过并停留，实际报告“青色线跟随，但有明显空隙”；本地 item-hover.png 也显示曲线随图标位置变化但有空隙。因此 AXList 和 AXDockItem 都不能不经修正就被当作实际像素顶部，也不能据此断言整个 AX 能力不可用。

公开 SCK 元数据枚举得到 Dock 窗口 42、frame 为整屏；该 ID 仅在本次会话有效，不能硬编码。元数据探针先检查现有屏幕录制权限，无权限时退出而不发起 SCK 查询。实际桌面与沙箱结果分别见 [capture-windows-desktop.json](capture-windows-desktop.json)、[capture-windows-sandbox.json](capture-windows-sandbox.json)。后者是沙箱不可用环境，不是用户在产品授权框中按下拒绝的证据。

使用系统 `screencapture -x -o -l WINDOW_ID LOCAL.png`（静音、排除阴影）实际取得 2940×1912 的透明 PNG，只含 Dock 图像。`dock-alpha.swift` 仅读取已存在的本地 PNG，以显式 alpha 阈值提取每列顶部／每行内侧轮廓，不负责实时采集。下列范围来自阈值 128，均为源图像像素，不能与前述点坐标直接混用。128 是实验参数，不是已确认的产品命中阈值。

| 场景 | 实际像素结果 | 验证边界 |
| --- | --- | --- |
| 底部静止 | x=291、y=1744、宽=2358、高=158；370712 个阈值内像素 | 顶部对应屏幕 y=872 点，比 AXList 顶部低 5 点；真实桌面青色轮廓与圆角背景上缘贴合，仅本机静态对齐 |
| 底部隐藏 | 非零 alpha 像素数与阈值内像素数均为 0，无轮廓 | 隔离截图没有返回旧的可见 Dock 内容；只验证这次显隐，不外推全部工作区或切换时序 |
| 左侧 | x=9、y=140、宽=118、高=1700 | 可提取向内的逐行边缘，供未来避让研究；不实现攀爬 |
| 右侧 | x=2813、y=140、宽=118、高=1700 | 同上 |
| 悬停放大 | 原始 alpha 包围盒 y=1660，宽=2490；其中包含分离的文字提示 | 原始全 alpha 最上缘会误选提示标签，不能直接站位 |
| 悬停放大，最大四连通分量 | 排除本帧分离的提示标签后，x=225、y=1744、宽=2490、高=158；保留391568像素 | 实际观察是主体横向扩张，主体顶部在此放大配置仍为 y=1744；不能假定任何放大设置都保持该高度。最大分量是实验性分割，可能遗漏分离图标、徽标或菜单，不是通用产品规则 |

数据、输入文件 SHA-256、阈值和分割方式见 [raster-summary.json](raster-summary.json)；30 张有界隔离截图的逐帧原始 alpha 范围见 [raster-frame-summary.json](raster-frame-summary.json)，其中末两帧包含悬停提示。未生成虚构的逐帧同屏误差或实时延迟结论。

Retina 覆盖线最初被错误的 `CGDisplayPixelsWide/High` 尺寸判断拒绝；本机该接口为 1470×956，而原生截图为 2940×1912。`2362ab8` 改为匹配主屏 `NSScreen` 的点尺寸乘 backing scale，实际映射比例为 2×，并在真实桌面截图确认轮廓对齐。[raster-mapping.json](raster-mapping.json) 保存修复后的映射信息。等尺寸不证明来源，只有已知来自完整当前主屏、未裁剪的图像才可这样映射。

选定的本地图片另保存于 `/Users/frost/.codex/visualizations/2026/10/20/01a15879-c49a-7f92-b301-cefd8f66a866/dock-issue-14/`，包括原始隔离图、悬停帧、真实桌面的橙色／青色对照和隐藏场景。该目录仅在本机可用；临时连续帧仍位于 `/tmp/mosey-dock-probe/`。仓库只保存数值诊断，不保存图片内容。

## 接入建议与尚未完成事项

已确认：本机已获授权宿主上，原生单窗口截图确实包含可提取的 Dock 图像；AX 语义矩形不能直接充当像素边缘。合理推测：若公开 SCK 的独立窗口采集同样保留透明度，可以将像素处理封装到集中原生适配中，避免在正式产品不断启动 `screencapture` 子进程。后续独立窗口实时流已在本机取得透明帧，并完成独立原生.app授权前后对照，见[实时试验](live/README.md)。这仍不证明最终Electron桥接或通用分割可用。SCK 的显示器包含应用／窗口过滤器会排除 Dock。

用户已接受将屏幕录制权限作为候选并继续验证。实时采集、帧时序及一次显隐已有原始记录；仍需验证窗口 ID 重建、工作区、分割和错误恢复。像素路线目前不证明可以完全替代 AX，亦未测无需 AX 授权的组合。采集和处理不得阻塞输入／渲染线程；不在主进程逐帧传输整屏图片。正式桥接、签名身份和权限归属仍未确定，不默认为权限成本可接受。

独立探针、CLI 外部行为检查和这一轮可视实验已完成；以下仍未验收，故 #14 保持未完成，不把候选实验称为可靠实时攀爬能力：

## 尚未完成

- 持续放大下的实时精确对齐、实时侧边显隐、遮挡、标签相连／分离图标等分割边界；实时底部显隐和独立原生.app采集见新增记录。
- 独立原生探针的屏幕录制撤销后重启已验证为BLOCKED且未启动采集，见[实时试验](live/README.md)；采集中撤销、提示中拒绝、AX撤销及最终产品身份仍未验证。
- 屏幕录制权限已获准作为候选继续试验；正式产品权限与原生桥接尚未锁定。
- 最终固定的开发版、打包 Electron 环境和显示矩阵复验。

最终只读核对确认已恢复底部、自动隐藏开启、tilesize=59、magnification=true。所有探针与覆盖线均有界结束。没有修改用户权限，不取消 #8 攀爬，不引入固定边界降级。


## 后续验证的历史范围说明

本页“尚未完成”和“没有修改用户权限”记录当时原生探针阶段的状态，不是后续正式 Electron 验证的当前结论。用户之后明确授权了屏幕录制候选，并完成冻结正式 Mosey 的手动授权与关闭权限后的独立重启对照；最终 Electron 事实、数值路径、早期验证接入建议及仍未测的产品边界见[正式 Electron 验证记录](../../../docs/validation/issue-14-electron.md)。本页原始历史保持不变，是否完成 #14 早期验证范围由后续 spec review 判断，不把产品攀爬或实时撤权时序写成已通过。
