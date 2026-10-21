# #8：真实 Dock 边缘交互

## 实现与边界

在包含 #14/#15/#7/#9 及 #22 的 `origin/main` (`7d34491`) 上实现。未升级锁定工具链，仍为 Electron 44.9.1 / Forge 8.0.1 / Vite 8.3.4 / Node 24.18.0 / pnpm 12.11.2。#14 是路线验证，原始 probe、协议及历史证据保持独立；本票没有把其关闭状态视为产品攀爬验收通过。

产品 `native/dock-runtime.swift` 使用公开 ScreenCaptureKit 独立 Dock 窗口过滤、本地 BGRA alpha128 最大连通分量及逐列/逐行实际边缘。输出只有受限数字轮廓，无像素文件、音频、上传或外部守护程序。Dock host 的整屏矩形只用于确认捕获身份和像素映射，不充当可站立边缘。底部/左/右方向由连通 alpha 与显示器边缘的相对位置识别，不读取 Dock 偏好或依赖人工方向标签。24 DIP 是形状边缘识别容差，支撑坐标仍逐点来自 alpha。

公开替代方案的既有证据见 #14：workArea、CGWindow 容器和 Dock 设置不能给出真实可见轮廓；AX 容器也不保证反映放大后的轮廓。采用现有已验证的隔离像素路线，而非加入私有 AppKit 适配。此选择需要 Screen Recording 权限，增加 Swift 编译/签名、进程与协议、可见边缘资源成本，不承诺无权限攀爬。

helper 以 `arm64-apple-macos15.0` 编译，该参数是桥接 API 编译下限，不是新确认的完整产品最低系统声明。开发 helper 在 `build/native/dock-runtime`，打包在 asar 外 `Contents/Resources/native/dock-runtime`，以 `dev.frost.mosey.dock-runtime` 本地 ad-hoc 嵌套签名。`runtime-receipt.json` 分别记录源码哈希、构建二进制哈希、Swift/参数与签名；Forge 再签名后以实际包内字节为准，不能把构建 receipt 哈希当成最终包哈希。没有 Developer ID、公证、授权持久性或其他平台承诺。

## 当前性、资源与生命周期

捕获队列深度3、100ms最低帧间隔，单 worker 加最新完整帧槽。新完整帧立即失效旧边缘；较老处理结果不能覆盖新序号。仅新鲜完整帧或无跨间断的 idle 心跳可以提供边缘；callback silence、不完整帧、源过期、映射错误、主屏/缩放或 Dock host 变化都清空边缘。原始 source age 与 callback age保留，idle 不伪造新像素时间。

主进程使用固定路径直接 spawn，无 shell。Zod 严格校验初始 PID/父 PID、有限数值、顺序、主屏身份与边界、轮廓轴单调性与实际包围区间，单行512KiB、接收缓冲1MiB、stderr32KiB。宿主另有启动10秒和输出1.5秒期限，校验相对 elapsed 传输进度；source/callback age叠加可观察相对传输延迟。初始 environment 本身被缓冲的绝对时长不能仅由相对时钟证明，不将此当作输入延迟性能验收。

原生限制屏幕尺寸、像素数、分量裁剪面积和最多16384个轮廓点。收到新帧尚未分析完成时，产品只暂停原地最多250ms，不使用旧边缘移动；持续 pending 超时回原地面。暂停的运动时间不补跑。隐藏、锁屏、休眠、退出释放捕获并清除边缘；stop 先 SIGTERM，1.5秒后针对同一个已捕获子进程 SIGKILL。子进程另有父进程消失监测。快速隐藏/显示和屏幕重配重启受期望可见性与 generation 约束，不复活隐藏捕获。普通错误可在仍可见时重试；权限拒绝/撤销后停止自动重试，由用户明确重试。

诊断捕获与产品捕获不同时运行；启动 #14 诊断先停止产品 helper，恢复产品需 Retry 或重新显示。日志沿用本地主日志1MiB轮转，默认不逐帧写运行日志。本文归档的 native 数字流是明确执行的一次验证，不是产品持续记录。

## 行为与素材

主进程按当前已绘制帧、方向、同源 alpha 命中行、脚底锚点和三档缩放计算实际身体范围，所有运动使用 Electron 全局 DIP。底部轮廓与身体横向相交才使用相交段最高真实边缘；无交集保留原 workArea 地面。左右轮廓只在身体垂直范围相交时横向避让。地面仍为当前主屏 workArea 底部，未把 workArea 当作可见 Dock 证据。

XState 新增 climbing、CLIMB/DROP 及带 actionId 的落地完成。拖动、回落、攀爬、自由活动通过统一 motion 取消与动作编号衔接；在可见边缘下方松手转为从当前位置攀爬，不在 falling 首帧向上跳到边缘。主屏变更取消捕获/旧运动后重新计算，隐藏意图保留。菜单暂停沿用同一活动时间；几何 pending 的短暂停不补跑桌面运动。

四个攀爬源姿态依次 reach/pull/tuck/stand，使用已建立 sharp 图集/同源命中管线。生成提示、参考、来源路径、alpha 连通分量和特殊裁剪区域见 `issue-8-climb-source.json`。原始图保留，底行在x680分割避免鼻子跨等分单元污染；真实全套动作视觉验收仍需实际桌面证据，静态身份检查不作为自然衔接通过。

## 已取得的证据

- 初始整应用红测试：底部重叠边缘目标 foot881，旧产品仍 foot956；实现后可见支撑通过。随后真实 Canvas 像素检查发现 pending 期间闪为 falling 姿态，修复为暂停原姿态，红/绿均实跑。
- 开发测试的确定性生产者情景通过：底部重叠/不重叠/失效回落、pending暂存及超时、三档缩放、在边缘下方释放不向上瞬移、回程再抓取、侧边避让、隐藏及快速再显示。此情景运行真实 Electron、行为、Renderer、素材、协议消费与窗口，只替换 OS 捕获生产者，明确不证明真实 Dock 像素、实际跨应用输入或物理权限通过。最终开发/打包完整结果待下文补齐。
- 独立 native 实验数字流 `issue-8/native-observation.jsonl` 与 `native-initial-summary.json`：本机 macOS27.0.1(26A434)/arm64、Swift6.4，由 Codex 宿主启动复制 helper，继承权限。1145个观测中24个非null，均bottom，例如elapsed69.886附近真实完整帧轮廓1120点、bbox x175.5 y872 w1119 h79；其余包括incomplete/callback silence/alpha empty。没有受控指针或Dock设置操作，同期外部用户/UI活动未知，不作为同步地面真值、应用攀爬或独立LaunchServices获权验收。源码/构建字节关联见 `native-initial-receipt.json`。
- `issue-8/native-resource-sample.json`：单独helper在Dock隐藏/不完整场景7秒内，ps报告lifetime CPU0.1–0.7%、RSS28848–28912KiB。不是整应用、活动/放大、长时或耗电测量；未确认资源预算，不据此宣称低功耗。

## 尚未通过或未测

#8 保留 OPEN，以下不由模拟数据、#14已关闭、属性读回或本地静态成功替代：

- 冻结最终打包应用，通过独立 LaunchServices 复验未授权/拒绝/授权/实际运行中撤权与重新启动，明确权限归属和成本可接受性；#14历史身份不能移植到本票新二进制。
- 真实 Dock 显隐、放大/tooltip、底部重叠与非重叠、左右避让及回落，留同时可核对的真实桌面和应用几何证据。
- 实际三档/1×2×/主屏变更/外屏断开组合、真实第一次命中/透明穿透与拖放组合；自动化的 directed Playwright 输入不是跨应用系统输入证明。
- 四帧攀爬在实际桌面尺寸的身份、动作衔接与打断视觉验收；强放大/tooltip是否可靠分割、仅识别primary全屏Dock host的能力限制。
- 整应用活动捕获CPU/内存/耗电/延迟、长时增长与预算，以及其他macOS/显示组合。没有把负面结果改成固定边界，也没有自行取消攀爬需求。
