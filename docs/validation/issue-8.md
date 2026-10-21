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

诊断与产品以同步预留的 capture mode 和 intent revision 仲裁；启动 #14 诊断先预留独占意图，再等待产品 helper 停止。关闭期间的隐藏/显示不会重新激活旧产品进程，所有异步完成检查最新意图。Stop 诊断等待其子进程退出后，在仍可见且未暂停时恢复产品；Retry 明确切回产品。诊断自然到时结束后仍可用 Retry 恢复。日志沿用本地主日志1MiB轮转，默认不逐帧写运行日志。本文归档的 native 数字流是明确执行的一次验证，不是产品持续记录。

## 行为与素材

主进程按当前已绘制帧、方向、同源 alpha 命中行、脚底锚点和三档缩放计算实际身体范围，所有运动使用 Electron 全局 DIP。底部轮廓与身体横向相交才使用相交段最高真实边缘；无交集保留原 workArea 地面。左右轮廓只在身体垂直范围相交时横向避让。地面仍为当前主屏 workArea 底部，未把 workArea 当作可见 Dock 证据。

XState 新增 climbing、CLIMB/DROP 及带 actionId 的落地完成。拖动、回落、攀爬、自由活动通过统一 motion 取消与动作编号衔接；在可见边缘下方松手转为从当前位置攀爬，不在 falling 首帧向上跳到边缘。主屏变更取消捕获/旧运动后重新计算，隐藏意图保留。侧边避让的已应用横向修正保留在当前脚底/行走路径中，Dock 消失或身体离开其垂直范围时不会回弹到旧横坐标；行走仍保留原分数轨迹，避免逐帧整数窗口舍入累积漂移。菜单暂停沿用同一活动时间；几何 pending 的短暂停不补跑桌面运动。

四个攀爬源姿态依次 reach/pull/tuck/stand，使用已建立 sharp 图集/同源命中管线。生成提示、参考、来源路径、alpha 连通分量和特殊裁剪区域见 `issue-8-climb-source.json`。原始图保留，底行在x680分割避免鼻子跨等分单元污染；真实全套动作视觉验收仍需实际桌面证据，静态身份检查不作为自然衔接通过。

## 已取得的证据

- 初始整应用红测试：底部重叠边缘目标 foot881，旧产品仍 foot956；实现后可见支撑通过。随后真实 Canvas 像素检查发现 pending 期间闪为 falling 姿态，修复为暂停原姿态，红/绿均实跑。
- 开发测试的确定性生产者情景通过：底部重叠/不重叠/失效回落、pending暂存及超时、三档缩放、在边缘下方释放不向上瞬移、回程再抓取、侧边避让、隐藏及快速再显示。此情景运行真实 Electron、行为、Renderer、素材、协议消费与窗口，只替换 OS 捕获生产者，明确不证明真实 Dock 像素、实际跨应用输入或物理权限通过。开发与打包结果范围见下文。
- 独立 native 实验数字流 `issue-8/native-observation.jsonl` 与 `native-initial-summary.json`：本机 macOS27.0.1(26A434)/arm64、Swift6.4，由 Codex 宿主启动复制 helper，继承权限。1145个观测中24个非null，均bottom，例如elapsed69.886附近真实完整帧轮廓1120点、bbox x175.5 y872 w1119 h79；其余包括incomplete/callback silence/alpha empty。没有受控指针或Dock设置操作，同期外部用户/UI活动未知，不作为同步地面真值、应用攀爬或独立LaunchServices获权验收。源码/构建字节关联见 `native-initial-receipt.json`。
- `issue-8/native-resource-sample.json`：单独helper在Dock隐藏/不完整场景7秒内，ps报告lifetime CPU0.1–0.7%、RSS28848–28912KiB。不是整应用、活动/放大、长时或耗电测量；未确认资源预算，不据此宣称低功耗。

## 尚未通过或未测

#8 保留 OPEN，以下不由模拟数据、#14已关闭、属性读回或本地静态成功替代：

- 冻结最终打包应用，通过独立 LaunchServices 复验未授权/拒绝/授权/实际运行中撤权与重新启动，明确权限归属和成本可接受性；#14历史身份不能移植到本票新二进制。
- 真实 Dock 显隐、放大/tooltip、底部重叠与非重叠、左右避让及回落，留同时可核对的真实桌面和应用几何证据。
- 实际三档/1×2×/主屏变更/外屏断开组合、真实第一次命中/透明穿透与拖放组合；自动化的 directed Playwright 输入不是跨应用系统输入证明。
- 四帧攀爬在实际桌面尺寸的身份、动作衔接与打断视觉验收；强放大/tooltip是否可靠分割、仅识别primary全屏Dock host的能力限制。
- 整应用活动捕获CPU/内存/耗电/延迟、长时增长与预算，以及其他macOS/显示组合。没有把负面结果改成固定边界，也没有自行取消攀爬需求。

## 代码审查修复与自动化记录

初版源提交 `c66e877` 的完整打包套件为7文件、9/9通过，见 `issue-8/packaged-initial.log`；严格递归签名验证通过。初版应用并未获得本票独立 LaunchServices 授权，后续审查发现的问题使其不作为最终验收候选。

审查后在同一实现代理内完成一轮修复：

- `capture-mode-red.log` 在真实 Electron 上先 SIGSTOP 自有产品 helper，再通过菜单启动诊断并立即隐藏/显示；诊断已实际 Capturing 时仍出现重启的产品 helper。修复为在任何 await 前同步预留模式与修订号、对各异步完成复核意图。测试使用实际诊断窗口和 OS 子进程观察，不断言内部布尔值。
- `walking-side-red.log` 与 `falling-side-red.log` 分别观察到侧边轮廓清除后99与80DIP的相邻采样横坐标跳变。修复行走的持久避让偏移及下落每次取当前横坐标，覆盖左右两方向；继续保留严格地面、保持抓取、大小和短距离行走断言。
- 原生编译、签名、哈希和 receipt 生成提取为同一函数，历史探针与产品源、输出名、签名标识及 receipt 文件继续分别指定，未覆盖历史身份。
- 开发显示恢复中曾在旧位置发布 resting 后误启动新 CLIMB；红/绿在 `development-display-recovery-{red,green}.log`，修复为先稳定位置再转换行为，并让重复 null 无能力变化报告不触发新运动。

开发调试曾观察初始 Vite 导航 ERR_ABORTED，以及另有 alpha0/菜单状态Stopped的 readiness 失败，见 `development-startup-readiness-unresolved.log`；未保留零像素同次的 isVisible/ready-to-show 完整事件链，根因尚未确立，不声称修复或进程崩溃。测试明确等待实际 alpha 像素，不以 Hide/Show 作为启动回避。后续有完整渲染并进入预期回归断言的实跑。未通过的 readiness 尝试不写成代码缺陷的红证据，也不虚构稳定性结论。临时 DEBUG 代码已从测试源清除；归档的失败日志保留当时观测上下文，仅将EOF空白规范化为一个末尾换行，`/tmp/mosey-issue-8/`中的采集原件保持原样。

修复后的 `pnpm check` 通过。Dock开发文件2/2通过（39.60秒，`development-review-dock-green.log`），保留初始完整情景并新增capture handoff、左右两侧在行走/下落期间消失后的无回弹验证；同一修复运行源码的自主活动与大小组合两文件各1/1通过。结果来自两次有明确范围的运行，不伪称一次完整开发套件全部通过。

新增深拖动情景在真实物理光标所在列受到buttons0事件干扰，或显示后尚未确认新姿态时，不能据此判产品回弹；夹具沿用既有自主活动测试的策略，将实际窗口放到远离物理光标的列，并等待70ms输入/绘制消息后再抓取，仍保留完整抓取、450ms位置保持、精确地面和逐采样回弹断言。诊断状态窗建立后始终使用最初宠物窗口ID，避免Electron窗口列表顺序把状态窗误认成宠物。失败时仍保留菜单、OS进程状态与截图诊断；临时quit包装、DEBUG及调试env分支已移除。

最终修复源码重新执行 `pnpm package:mac` 及 `codesign --verify --deep --strict` 通过；实际候选及哈希见 `issue-8/packaged-review-receipt.json`。最终包完整套件为5文件通过、2文件失败（7/9，201.08秒），见 `packaged-review-full.log`：新增Dock情景2/2通过，大小、自主活动大小组合、显示恢复和可见性通过。原有自主活动测试在抓取保持期间从y416回落到y716；菜单测试拖动未离开y716地面。两者当时实际横坐标均为居中x615，尽管夹具尝试远离物理光标放置，缺少完整事件链，根因未确认，不能据此标为夹具或产品已确认缺陷。

不改源码、夹具、构建或签名，随后仅复跑这两个失败文件，2/2通过（53.12秒，`packaged-review-input-rerun.log`）。这是同一最终二进制的分次覆盖，不宣称一次完整最终套件全绿，也不宣称输入稳定性或物理桌面验收通过。归档的 `packaged-autonomy.json`、`packaged-menu.json` 为这次定向复跑的成功输出；完整运行的原始失败保留在前一日志，未用复跑覆盖。未为未确定根因增加推测性的产品启动或输入修复。

## 前一候选的集成保留与独立启动交接

最终代码及记录合并到 `integration/issue-8-dock`。同一已测试应用已复制到集成 worktree 的 `out/issue-8-acceptance/Mosey.app`，复制后严格递归签名验证通过，未重建或重签。实际 asar SHA256为 `5fa938dcdfedac6ceb2672a5ab9f155c49bb3a015d7c2a8204312eacdd0b6efb`，runtime为 `77d78ab0cb47d271f34c13870ec47e6a096d03ea18999290d40fd80f9ebfc640`；详见 `issue-8/frozen-acceptance-provenance.json`。未跟踪测试结果另保留在集成 worktree 的 `test-results/issue-8-implementation/`，不随实现 worktree 归档丢失。

通过 CUA 从 Finder 精确目录选择并打开候选，未观察到新候选进程。只读进程检查发现另一项 #5 工作的独立 Mosey 正在运行，PID47162、父PID1、路径为 `/Users/frost/code/mosey/out/issue-5/Mosey.app`，无自定义 profile 参数。结合两份应用使用默认 Mosey profile 及既有单实例守卫，这是新候选未出现的合理解释；未采集新候选锁返回值，不将其写成启动缺陷或独立权限拒绝的证据。此前直接 CUA 路径绑定超时也只代表工具失败。保留另一项工作的实例，没有停止它或改变系统权限。

继续独立验收需要用户结束旧实例、打开这里保留的候选，并明确授权屏幕录制及必要的临时 Dock／显示设置测试。当前未证明新候选独立授权、拒绝或运行中撤权，不把宿主继承捕获移植为本应用权限。#8 保持 OPEN。

### Standards

复审确认捕获模式交接竞态和重复构建流程已解决，0项未解决代码标准发现；这不代表所有自动化运行无失败。

### Spec

复审确认旧横向原点回弹 P2 已修复，无新增确认的代码问题。真实桌面／独立权限验收 P1 仍待完成。最终完整打包7/9与同产物失败两项复测2/2分别保留；偶发输入失败原因未确认，不宣称最终一次完整全绿。

## 远端 CI 显示恢复回归与后续修复

远端CI运行39580428529在开发套件中原有 `tests/app.test.ts:777` 的idle显示恢复保持断言失败：预期 `{x:744,y:426,width:240,height:240}`，实际y462，其余6文件通过（7测试通过、1跳过）；保留 `issue-8/ci-39580428529-development-failed.log`（仅规范化行尾空白，原件仍在 `/tmp/mosey-issue-8/ci-failed.log`）。此结果推翻前一候选已充分覆盖显示恢复的判断，asar `5fa938dc…` 及其旧冻结副本不再是最终验收候选。历史receipt和日志保留原记录，不改写为后续结果。

新回归仅替换既有OS捕获生产者，在真实Electron中先发主屏重配边界，再持续发送pending、最后null，整个情景从未提供非null Dock边缘。旧代码确定性地把恢复后的y676移动到y716（`display-pending-red.log`）。临时公共 `BrowserWindow.setPosition` 调用栈记录（`display-pending-public-geometry-red.log`）显示先由displayChanged→cancelInteraction→alignGround定位y676，约408ms后由下落定时器逐帧移动到716；不是权限状态或未解释的外部原生移动。此情景重现了异步pending结束仍把普通地面差异解释为Dock支撑丢失的代码路径；不据此推断全部先前输入失败均为同一原因。

修复提交 `1dbee6a` 限制垂直Dock动作的发起：必须有当前真实重叠底边支撑，或先前已经观察到的该支撑刚丢失。单独pending/null不拥有其他桌面位置；侧边修正继续独立应用。主屏重配、隐藏和暂停同时清除支撑所有权、pending期限及计时器。真实生命周期仍通过已有对齐逻辑处理。无生产测试钩子、无放松位置断言、无原生协议变化；临时DEBUG包装已移除。

`pnpm check`通过。原有 `tests/app.test.ts` 和新增回归所在的完整 `tests/dock.test.ts` 开发定向运行通过：2文件、3通过、1跳过，95.85秒（`display-pending-development-green.log`）。新 `pnpm package:mac` 及严格递归签名验证通过，候选receipt为 `display-pending-package-receipt.json`，asar SHA256 `989fab98a3a7bb14a55bddf9d3b950ee8a55c79f211d0f5ee2501826ce37170b`，runtime仍为 `77d78ab0…`；此前5fa938dc候选不再用于后续验收。

新包相同两文件定向运行3通过、1失败（71.23秒，`display-pending-packaged-focused-failed.log`）：Dock2/2和独立Renderer启动通过；主app情景在显示重配注入前的line670未返回已收集idle图像集合，前一行地面坐标断言通过。失败PNG保留在 `display-pending-packaged-failure.png`。静态alpha差异比较发现其最接近攀爬末帧3、右向（误差11602，次近landing为1203817；sharp插值与Chromium不同，不能算精确相等或已确认运行状态）。没有同次presentation／原生帧事件链，不能确认动作启动及保持原因，也不标为普通idle方向差异或已修复代码缺陷。

随后不改源码、夹具、包或签名，仅复跑原app文件，2/2通过（51.15秒，`display-pending-packaged-app-rerun.log`）。这是同产物分次通过覆盖，不声称一次完整打包全绿，不掩盖首跑像素失败。新回归与原显示恢复的开发验证已通过，物理桌面／独立权限验收仍未完成。
