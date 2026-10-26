# Mosey

> #11 交付状态（2026-10-25）：本地验收候选，尚未宣称完整技术验收通过。构建下限为 macOS 15 / Apple Silicon；这不是全部 macOS 15 及以上版本的验证声明。联合回归、资源采样方法与待验收项见文末。

> 状态（2026-10-21）：保留 #3 已实现的点击互动，仅取消“点击宠物后保持原输入框键盘焦点”的验收要求；点击后可能需要重新点击输入框恢复输入。不采用私有 AppKit 焦点适配，其余功能和验收标准保留。

单只柯基的本地 macOS 应用。清醒时点击可见身体，随机歪头、伸爪或翻肚，连点合并且不排队；拖动可打断动作，松手后扑腾、下落并蹲下落地。柯基平时休息，偶尔散步、伸懒腰或自己玩；清醒活动约两分钟后在下一次休息调度躺下睡觉。睡眠第一次点击只动耳，900ms内第二次点击才醒，拖动立即唤醒。保持静音、无文字、无需照料。见 [#5 行为、素材与验证边界](docs/validation/issue-5.md)。

透明窗口默认160×160 DIP，位于主屏可用区域底部；菜单栏 🐾 提供设置、显示／隐藏和退出，本体右键菜单提供隐藏与退出。设置窗口提供小／中（默认）／大预设，分别为70／160／240 DIP，并提供70–240 DIP、步进10 DIP的滑块；拖动实时生效，松手或方向键操作停止后保存，大小和隐藏意图跨重启保留；关闭设置后宠物继续运行。开机启动已迁入设置，以 macOS 实际状态为准，不写入偏好文件；开发版说明不可用原因，打包版支持开启、关闭、等待批准时取消请求及打开系统设置，返回设置窗口后刷新系统状态。真实注销／登录与系统设置桌面导航尚需人工验收；受控批准与失败场景仅验证真实 Electron 设置 UI 和 IPC，不等同系统批准通过。本切片的迁移、失败重试与验证边界见 [#31 设置窗口验证](docs/validation/issue-31-settings.md)。透明区域使用当前帧同源alpha切换鼠标穿透；8ms光标轮询仍有首次进入竞态；点击后不保证保持原工作应用的键盘焦点，这已不属于验收要求。真实桌面观察与剩余时序风险分别记录，见 [#3 证据与限制](docs/validation/issue-3.md)。已接入真实 Dock 边缘攀爬、落回与侧边避让，详见下文。

## 运行与验证

在 Apple Silicon Mac 安装 Node **24.18.0** 与 pnpm **12.11.2**，然后：

```sh
pnpm install --frozen-lockfile
pnpm start
```

正式入口是根目录的 pnpm / Forge 流程。Dock 原生辅助程序源码位于 `src/platform/native/dock-live.swift`，由 `pnpm native:build` 编译并签名至 `build/native/`，开发启动和打包前自动构建，打包时随应用交付。

原生 CLI 回归检查：先运行 `pnpm native:build`，再运行 `python3 tests/native/test-dock-live.py build/native/dock-live`。历史日志的稳定阶段校验工具保留在 `tools/check-dock-live-phase.py`，参数可用 `--help` 查看。旧 `probes/` 实验、原始结果和根目录 `assets/` 测试素材已移除；正式角色素材保留在 `src/assets/`。

```sh
pnpm assets:build   # sharp 制作图集、版本化描述及同源 alpha 命中数据
pnpm check          # strict TypeScript、ESLint、Prettier
pnpm test:dev       # Forge 开发服务器 + 真实 Electron
pnpm package:mac    # Forge + 官方 Vite 插件，构建本地 darwin-arm64 .app
pnpm test:packaged  # 启动刚生成的真实 .app
```

`pnpm build` 通过相同 Forge package 流程构建当前平台产物；本票交付与测试限定 macOS arm64。应用在 `out/Mosey-darwin-arm64/Mosey.app`，可用 Finder 打开。打包使用 Forge 的 macOS 签名流程进行本地 ad-hoc 签名；没有开发者证书、公证或自动发布，交付范围是本机验证。首次安装需要网络下载依赖与 Electron 二进制。

单 package，无 packages workspace 字段。pnpm 12 将设置统一放在名为 `pnpm-workspace.yaml` 的配置文件；该文件只管理安装策略，未引入多包 workspace。Forge 要求 hoisted 安装布局，使用 `nodeLinker: hoisted`。Electron 44 npm 包提供显式 `install-electron`，根包 postinstall 执行该命令，避免首次启动时才下载。开发 Node 由 `.node-version` / `.nvmrc` / engines 锁定；Electron 内置 Node **24.22.0** 随 Electron 升级，不能用开发 Node 替换。

## 已锁定组合

直接依赖均无版本范围；完整传递依赖见 `pnpm-lock.yaml`。

| 工具                                       | 精确版本                           |
| ------------------------------------------ | ---------------------------------- |
| Node / pnpm                                | 24.18.0 / 12.11.2                  |
| Electron（内置 Chromium / Node）           | 44.9.1（152.0.7977.167 / 24.22.0） |
| Forge CLI / 官方 Vite 插件 / shared-types  | 8.0.1                              |
| Vite / Vitest / Playwright                 | 8.3.4 / 5.0.5 / 1.64.1             |
| TypeScript                                 | 6.0.3                              |
| ESLint / @eslint/js                        | 10.13.0 / 10.0.1                   |
| typescript-eslint / eslint-config-prettier | 8.72.0 / 10.1.8                    |
| Prettier                                   | 3.9.10                             |
| XState / Zod / electron-log / sharp        | 5.33.3 / 4.6.7 / 5.4.4 / 0.35.5    |
| pngjs / @types/pngjs / @types/node         | 7.0.0 / 6.0.5 / 24.10.0            |

2026-10-20 核对 [Node 生命周期](https://nodejs.org/en/about/previous-releases)：Node 24 是 LTS。[Electron 官方支持最近三个稳定大版本](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)，本次采用 npm registry 当日稳定版 44.9.1。typescript-eslint 8.72.0 要求 TypeScript <6.1，故选 6.0.3，不盲目采用 TypeScript 7。升级独立提交，重跑开发、打包及整应用验证。

## 构建约定与兼容成本

[Forge 官方 Vite 插件](https://www.electronforge.io/config/plugins/vite) 与 [Playwright Electron 驱动](https://playwright.dev/docs/api/class-electron) 均仍标为实验性；锁定版本，并在升级时联合验证。未采用 electron-vite 或 Playwright Test。

源码统一 import/export；Vite 主进程显式输出 `.vite/build/main.mjs`（Forge 8 默认 CJS，需要覆盖 lib 格式）；renderer 输出 ES module；sandbox preload 为 `.vite/build/preload.cjs` 单文件。preload 仅暴露具体的表现状态请求／订阅与素材错误方法，边界使用共享 TS 契约和 Zod 校验。窗口保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，禁止新窗口与页面导航。HTML 使用 CSP，开发样式用外链 CSS，避免 Vite 注入内联样式被 CSP 拦截。

主进程在异步启动函数内等待 `app.whenReady()` 初始化，避免 ESM 顶层 await app.whenReady 与 Playwright 初始化加载器相互等待。开发测试仅为 Forge 的首个自动启动槽提供一个临时可执行占位程序，以保持其 Vite 服务器和 watcher 存活；随后由 Playwright 启动**真实且无测试分支的应用入口**。产品代码不识别测试环境变量。该占位程序不模拟渲染、菜单或 Electron API。

素材输入按动作保留在 `src/assets/corgi-*.png`。`tools/build-assets.ts` 使用 sharp 制作待机、互动、拖动、自由活动及睡眠的2x PNG图集、版本化JSON和同源命中区域；制作幅度、脚底锚点和透明边缘处理见 [#2 证据](docs/validation/issue-2.md)。`start` / `build` / `package:mac` 的 pre 脚本自动生成素材；生成物也提交，开发与打包均使用同一结果。开发由 Vite 提供图片 URL，生产通过 import 打包为带 hash 本地资源，随 asar 交付。

行为模块只依赖 XState 和 TypeScript，主进程分别管理姿态与系统可见性；renderer 按实际经过时间选帧，仅在帧改变时绘制，不可见时停调度。单实例锁在建立窗口／托盘之前获取；重复启动不激活已有窗口。日志只写本地 `~/Library/Logs/Mosey/main.log`，1 MiB 阈值与单份旧文件轮转，不上传，不开启逐帧日志。

## 验证记录与边界

2026-10-20，在本机 macOS 27.0.1（26A434）、arm64 上，先观察到打包程序尚不存在的真实启动失败，再实现并通过开发与打包整应用测试。测试由 Vitest 驱动 Playwright Electron API，检查单窗口、Canvas 超过 5000 个不透明像素、透明背景截图实际包含角色像素、连续截图变化、renderer 无 require、实际 preload 为 CJS，以及实际运行版本。通过应用菜单的 Quit Mosey 回调退出并等待进程 exitCode 0；finally 关闭应用、终止整个 Forge 进程组并清理临时目录。失败保存各窗口截图；成功截图与运行时 JSON 在 `test-results/`。

GitHub Actions 在官方 arm64 `macos-15` runner 上执行 frozen install、类型/lint/格式、真实开发测试、Apple Silicon 构建和真实打包测试，上传 app zip 与测试证据；失败不会跳过或伪报测试通过。本机结果不代表远程 CI 已运行，也不声明 macOS 15 已在本机验证。

#2 已接入 XState、受限 IPC、正式素材管线、单实例与本地日志，并扩展真实应用测试验证脚底与重复启动；本次记录见 [验证文档](docs/validation/issue-2.md)。真实桌面层叠、工作应用焦点、真实鼠标菜单栏退出及打包应用断网启动仍需独立证据。API 菜单回调不能替代真实鼠标验收，也不表示完整首版通过。

以下为 #13 工程基线历史记录，不作为 #2 新实现的通过证据：`pnpm check` 全部通过；清空 node_modules 后 `pnpm install --frozen-lockfile` 通过；开发整应用测试 1/1（1.70s），打包整应用测试 1/1（1.08s）。运行时 JSON 两种模式均为 Electron 44.9.1 / Node 24.22.0。打包截图已人工检查为完整、透明背景的柯基，无滚动条。测试后检查本工作树路径的进程列表，无应用或 Forge 进程残留。GitHub Actions 首次远程运行 [39397051399](https://github.com/Frost-96/mosey/actions/runs/39397051399) 在 setup-node 的自动包管理器缓存阶段失败：此时 pnpm 尚未安装，提示找不到 pnpm 可执行文件，后续应用检查均未执行。现已关闭 setup-node 的自动包管理器缓存，让锁定的 Node 先安装，再安装 pnpm；修复后的远程运行 [39397492660](https://github.com/Frost-96/mosey/actions/runs/39397492660) 全部通过，包括 frozen install、类型/lint/格式、真实开发测试、Apple Silicon 打包、真实打包测试和产物上传。

## 可选 Dock 验证（#14）

#14 的独立诊断入口仍保留。#8 现在在宠物可见且系统未暂停时启动单独的产品捕获 helper：已授权则本地分析 Dock 像素，未授权则在 preflight 阻断，不主动弹出权限申请。隐藏、锁屏、休眠和退出停止捕获。菜单栏 🐾 或应用菜单 **Dock validation** 提供 **Start Dock validation (120 seconds)**、**Stop Dock validation**、**Show Dock validation status**，以及 **Operator Dock orientation** 的 bottom / left / right 人工标签。先核对实际 Dock 位置，再选择方向并启动。状态窗显示原生 preflight 的 blocked / capturing / stopped 状态、最新已验证原生报告和可复制的本地日志路径。

此诊断入口与 #8 产品捕获独立；启动诊断会先停止产品捕获，避免同时占用捕获资源。诊断期间隐藏再显示仍保留诊断捕获的独占意图；**Stop Dock validation** 等待诊断退出后恢复产品捕获，或用 **Retry Dock interaction** 明确切回产品。自然到时结束后可用 Retry 恢复。产品捕获不可用时清除支撑边缘，不使用固定边界降级。不会主动申请或修改权限；Electron 的 screen 状态与 Swift 子进程自己的 preflight 分别记录，不能相互替代。需要授权时由用户在系统设置中手动操作；最终归属必须以该冻结应用的实际启动链与观察为准。详见 [Electron Dock 验证说明](docs/validation/issue-14-electron.md)。

## Dock 交互（#8）

宠物可见时，已授权的本地 ScreenCaptureKit helper 从独立 Dock 窗口提取真实透明轮廓，仅向主进程发送受限数字边缘。底部轮廓与跨动作稳定的身体横向范围重叠才攀爬；隐藏、失效或不重叠时回原地面；左右轮廓仅横向避让。角色和命中沿用同一大小、脚底与实际帧的 alpha 坐标约定。攀爬可再次抓起，菜单打开冻结运动；手动隐藏不会因 Dock 变化而恢复显示。

应用菜单及菜单栏显示 Dock 交互状态。若显示需要 Screen Recording 权限，由用户在系统设置手动授权当前实际使用的 Mosey，再选择 **Retry Dock interaction**，必要时退出并重开同一应用。应用不会自行更改权限，也不因拒绝授权而把一般工作区当成 Dock 轮廓。开发宿主权限不代表 Finder 独立启动的打包应用已经获权；本地 ad-hoc 重建、重签或移动应用后需重新核对实际权限。

`tests/dock.test.ts` 分开记录两类证据：确定性 OS 生产者替代所驱动的真实 Electron 行为，以及保持实际 Swift helper 的捕获传输、隐藏与退出清理。前者不代表真实 Dock 几何通过；后者也不代替独立 LaunchServices 授权与真实显隐／放大、三档、当前屏分辨率／缩放恢复验收。详见 [#8 验证记录](https://github.com/Frost-96/mosey/blob/2d6c3b8d97ba4aa1c2eab06fe4e4115cb4d94ca2/docs/validation/issue-8.md)。

#8 的原候选已通过用户六项定向复测及[完整云端回归](https://github.com/Frost-96/mosey/actions/runs/39978862581)（开发版17通过／1项仅打包版适用而跳过，打包版18通过）。与最新主线整合后的结果以 PR #38 检查为准。用户明确跳过60分钟资源测量，0样本，不计预算通过；历史独立1DIP、真实native -84DIP及Stop/Retry间歇失败原因仍未确认。原始桌面证据与历史验收记录保留本地，不重新引入主线已清理的验证文件。

## #11 联合交付记录

本次以开始实施时的 `9e3b937` 为基线。#5、#10、#16、#8 均已关闭，但历史通过状态不自动成为本次重建包的通过证据。没有推送的新提交不能引用旧 CI 作为本次 CI 结果；本地证据与 CI 分开记录。原始测试结果、截图和资源报告留在忽略的 `test-results/`，交付包留在 `out/`；不重新提交已经清理的历史验收目录。

本机为 Apple M5 / Mac17,3 / 24 GiB，macOS 27.0.1 (26A434)，内置屏幕当前逻辑尺寸 1470×956、2× backing scale、60 Hz。只记录当前主显示器；其他硬件、其他 macOS 版本、多屏以及真实切换分辨率／缩放均未由本次测量验证。测试中的强制 1× 与 CDP 2× 切换属于模拟条件。

应用包的系统下限已从 Electron 默认的 13.0 修正为 15.0，与两个 Swift helper 的编译目标一致。回归测试先在旧包观察到 `13.0 != 15.0` 失败，重建后通过；同时仍从仓库之外、仅含系统工具的 PATH 启动搬移后的 `.app`，检查真实 renderer 进程。这个隔离 PATH 的检查不等同于在一台从未安装 Node／pnpm 的机器上验收，也不等同于断网测试。

### 可复现验证

```sh
pnpm check
pnpm package:mac
pnpm test --reporter=default --reporter=json --outputFile=test-results/issue-11-vitest.json
python3 tests/native/test-dock-live.py build/native/dock-live
pnpm measure:resources --seconds 60 --growth-seconds 300 --output test-results/issue-11-resources
```

应用与素材均在本地 `.app` 中；Finder 打开 `out/Mosey-darwin-arm64/Mosey.app` 即可运行，不需要从终端调用 pnpm。使用菜单栏 🐾 显示／隐藏、设置或退出；设置与 Pet Size 菜单均可调整三档大小，设置还支持 70–240 DIP 滑块。隐藏意图跨重启保留，所以重开后没有角色时先检查菜单栏。关闭设置不会退出宠物。需要开机启动时明确启用；若系统要求批准，在系统设置完成，再返回应用确认实际状态。

Dock 捕获需要当前实际应用启动链已经获得 Screen Recording 权限；应用不会自动申请或修改权限。重签、复制或移动应用后应重新核对其权限与 Dock 状态。无法捕获时保持地面活动和本地诊断，不将该状态算作 Dock 验收通过。日志为 `~/Library/Logs/Mosey/main.log`，1 MiB 轮转阈值；诊断日志与资源报告留在本机。构建仍仅使用本地 ad-hoc 签名，不承诺公证、公开分发或自动更新。

### 联合回归覆盖与证据边界

| 父规格要求                                             | 自动化入口                               | 仍需独立记录的结果                                                                        |
| ------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| 点击、连点、透明命中、拖动、扑腾／下落再抓取、三档大小 | `app`、`size`、`slider`、`size-autonomy` | 跨应用真实鼠标、首次快速移入命中、完整动作视觉衔接                                        |
| 自由活动、睡眠、双击唤醒、菜单暂停                     | `autonomy`、`sleep`、`context-menu`      | 真实桌面长时间观察与打断感受                                                              |
| 大小／隐藏恢复、单实例、偏好互不覆盖、损坏／失败写入   | `visibility`、`settings`                 | 受控坏文件／失败提交不等于断电打断实际文件系统写入                                        |
| 渲染／主进程故障、隐藏与地面恢复                       | `renderer-recovery`、`ground-recovery`   | 启动、退出、恢复显示的跨应用焦点；真实屏幕缩放切换                                        |
| Dock 几何、失效、暂停、重建、诊断与产品捕获互斥        | `dock`、`dock-recovery`、`dock-status`   | OS 生产者替代与真实 helper 传输分别记录；本次冻结包的真实 Dock 几何尚需验收               |
| 登录启动与系统批准、失败重试                           | `login-items`、`settings-login`          | #10 的旧候选有用户注销／登录确认；本次包尚未重做两轮登录                                  |
| 无开发工具启动、离线与本地资源                         | `app` 的搬移启动与 Chromium offline 检查 | 10 月 25 日旧候选的真实断网冷启动已获用户确认；新候选及完全没有 Node／pnpm 的设备尚未验证 |

这些测试统一由 Vitest 驱动真实 Electron，管理退出清理并在失败时保存截图；模拟事件或属性读回不替代右列验收。当前包还需逐动作、逐尺寸观察身份、透明边缘、脚底、循环及衔接；有图集和像素检查并不等于视觉通过。

2026-10-25，用户对 `release/issue-11-20261025` 对应的旧候选确认：关闭网络、退出应用后从 Finder 冷启动，角色显示、点击、拖动放手、菜单隐藏／显示、Dock 显隐响应全部通过。这是用户提供的真实桌面验收结果；没有独立屏幕录制，不扩大为左右 Dock、不同缩放、完整动作视觉或无开发工具设备的通过证明。此前由真实右键菜单隐藏后，用户也已确认从菜单栏恢复显示成功。

随后通过原生菜单检查同一常驻候选时，菜单实际显示 `Dock interaction needs Screen Recording permission`。因此，上述显隐响应观察不能作为真实 Dock 轮廓捕获成功的证据；捕获权限及其对应的启动链仍需单独验收。

2026-10-25 本机首次完整运行结果为 **69 通过、3 失败、2 跳过**（32 个文件，1388.92 秒）。跳过项为仅打包版适用的启动／登录检查；报告为 `test-results/issue-11-vitest.json`。随后单独复现并修正了 Dock 测试的启动账本竞态：OS 已创建子进程不等于该进程已写出首条记录，现在限时等待记录后仍保留原静默时长和生命周期断言。隐藏渲染恢复的首次绘制等待改为与初始加载相同的 10 秒；一旦观察到非空画面就立即要求休息帧，不允许先重播旧动作再等到休息。对应两项定向测试通过。

睡眠组合在完整运行及一次单独运行中失败于不同阶段，之后带诊断两次及移除诊断后的原测试均通过；没有修改睡眠产品逻辑，也没有确认间歇失败根因。原生 CLI 参数、权限失败边界和阻塞 stdout 的退出期限检查通过。上述定向通过不覆盖首次全量失败，本次未获得最终代码的一次全绿整轮结果，未推送或产生本次远程 CI 结果。当前角色静态截图已抽查小档行走、中档伸懒腰及大档玩耍的可见轮廓与脚底，不能扩大为完整动画验收。

继续验收时，原睡眠条件的完整场景连续 3 轮、缩小的睡眠／菜单场景连续 12 轮通过。仅把外部休息计时器延迟从 500ms 改为 1200ms 后，原测试复现 `197 < 160` 失败：事件轨迹显示 `settling → 点击 → waking`，尚未进入 `sleeping`。这确认了测试用矮轮廓与固定等待误判睡眠前置条件的问题。现改为先从既有 renderer 契约等待 `sleeping`，仍保留画面、首次点击不醒、两次点击间隔及唤醒结果断言；1200ms 条件保留为回归刺激，开发版定向通过。未改产品睡眠逻辑；该受控复现不能证明先前不同阶段的全部间歇失败都出于同一原因。临时诊断代码已移出测试目录，轨迹保留在 `test-results/issue-11-sleep-original-5.json`。

续轮完整回归为 **69 通过、3 失败、2 跳过**（1359.52 秒，`test-results/issue-11-final-vitest.json`）。打包版全部适用项通过；开发版失败为大小组合找不到 `Hide Mosey`，以及睡眠／菜单组合保持拖动时意外回到地面。当时常驻候选也在运行，用户无法确认是否有人工输入。退出常驻候选后的定向复测，睡眠／菜单通过，大小组合仍失败；因而不能将失败直接归因于常驻实例或人工输入。下一次隔离整轮在大小组合再次出现拖动失败后中止，没有完整报告，不计为整轮通过。

组合场景的事件轨迹随后捕获到：测试尚未发送松手，`lostpointercapture` 已携带真实系统鼠标坐标到达，随后动作从拖动转为扑腾／下落；同期没有窗口失焦或显示器变化。针对测试主动移位窗口后立即合成拖动的交错，三处测试在移位后等待 100ms 再开始合成捕获；动耳／唤醒刺激放在这段准备之后，保留全部持有位置、响应时限和取消断言。修正后三个原失败组合定向通过（156.72 秒，`test-results/issue-11-settled-vitest.json`）。100ms 是本机验证的测试准备余量，不是跨环境事件完成保证，不代表真实鼠标验收或产品捕获逻辑修复；产品代码未改。失败轨迹保留在 `test-results/issue-11-sleep-drag-red-events.json`。另外，`Hide Mosey` 缺失的间歇来源仍未确认，大小测试只增加失败时的菜单／窗口快照，没有放宽断言。

用户确认可留出无鼠标／桌面切换的时间后，再次完整运行得到 **68 通过、4 失败、2 跳过**（1379.92 秒，`test-results/issue-11-final-isolated-vitest.json`）。该轮并非有效的持续解锁桌面基线：21:57 的公开生命周期账本明确记录 `lock-screen`，6ms 后首个 Dock producer 收到 SIGTERM；其静默持续约 592ms，未达到该测试要求的无打断 5000ms。此项确认是锁屏打断了测试前置条件，未因此改变产品的锁屏停止行为。该轮另有打包版首次隐藏恢复绘制超时，以及主交互／大小组合拖动失败；锁屏对这三项的具体影响尚未逐项证实，不能自动归因，也不能计为通过。后续完整运行需要用户先解锁并维持可用桌面环境；临时保持唤醒需限定到测试进程生命周期，不修改持久安全设置。

用户随后确认 Mac 已解锁，并明确允许仅在测试进程存活期间临时保持唤醒。使用 `caffeinate -diu`，同时限定进程生命周期与超时，未改持久系统设置；进程退出后已核对断言释放。上一轮四个失败项定向复测全部通过，但随后完整回归仍为 **69 通过、3 失败、2 跳过**（1389.32 秒，`test-results/issue-11-awake-full.json`）：开发版再抓取组合、开发版大小组合找不到 `Hide Mosey`、打包版隐藏后的渲染恢复。该轮 Dock 恢复全部通过；不能将剩余失败归于已解除的锁屏条件。

隐藏恢复单独 6 次通过，保留拖动／下落崩溃的前置顺序后重新失败。事件探针两次记录到像素读取发生于 `PID=0, isCrashed=true`，约 12ms 后才开始重载；读取一直没有返回，而故障快照显示新 renderer 已可见、休息并绘出 94254 个不透明像素。这确认了测试在故障请求返回后，过早用 `!isCrashed && !isLoading` 的瞬时读数判断替代进程就绪的问题。测试现先限时等待真实 `render-process-gone`，再保留原有重载、首帧休息、恢复次数及退出断言；同一有诊断顺序从 2 失败／4 通过变为 6 通过（`test-results/issue-11-recovery-barrier-vitest.json`），产品代码与冻结包未改。

菜单原大小前置条件的 5 轮探针及再抓取路径的 3 轮探针均通过，尚不能解释整轮中的两项间歇失败；这些短测不覆盖整轮失败，不作为已经修复的证据。

修正后的完整回归为 **70 通过、2 失败、2 跳过**（1416.56 秒，`test-results/issue-11-final-awake.json`）。开发版与打包版的 renderer 恢复各 7 项全部通过，Dock 恢复各 9 项也全部通过；剩余失败为开发版大小组合缺少 `Hide Mosey`，以及打包版主交互在隐藏期间模拟显示器变化后缺少 `Show Mosey`。这两项都发生于显示／隐藏菜单路径，尚未证实共享根因，也未计为通过。该轮临时保持唤醒进程退出后已确认不存在；本次仍未得到全绿整轮，不推送或借用旧 CI 结果。

2026-10-26，完整大小流程的菜单探针进一步复现：偏好文件仍为 `visible`、窗口也可见，但新的 `Hide Mosey` 菜单安装后，旧的 `Show Mosey` 快照又被安装；期间没有新的隐藏输入。构建调用栈记录到菜单构建期间重入较新的显示／隐藏操作。新增 `menu-reentry` 整应用回归在公开 Menu 构建／安装边界各注入一次较新的显示或隐藏命令，真实原生操作仍执行，且不改内部刷新状态；四种情况在原冻结包上全部失败。主进程现用刷新序号识别被更新请求取代的快照，并以循环重建最新应用菜单及待返回的托盘菜单。修复后开发版四项受控回归通过，原完整大小与主交互组合也通过；受控断言直接观察的是应用菜单、窗口和持久化偏好，不等于托盘真实鼠标验收。

此修复改变了应用代码，因此需要新候选自己的打包版、完整回归及真机证据。旧 `release/issue-11-20261025` 冻结包及其断网确认保留；下方原资源表也只属于旧包，不迁移为新包已经通过的证据。新包的系统权限、真实离线启动、登录与完整视觉验收仍需分别记录。

新候选冻结于 `release/issue-11-20261026`，`app.asar` 的 SHA-256 为 `fddfbe9b7aaea9e3d543b1797b3ed83b8542f03fe0cc471d24e3b6bc28b14537`；ZIP 的 SHA-256 为 `ca89e2f722af6d4cd4424f19300774cf2f27e36c5e310fcc38c35212c5770205`。打包、ZIP 完整性及本地 ad-hoc 签名检查通过。首轮打包版定向运行是 **13 通过、1 超时**（`test-results/issue-11-menu-fix-focused-packaged.json`），门禁失败后未启动完整回归。超时应用停在原生异常对话框，显示 `TypeError: timer._onTimeout is not a function`；进程取样未见 CPU 忙循环。已记录对话框与取样并清理该测试独占的残留进程，未把该次失败计为通过。

菜单回归驱动随后将外层激活命令调度到主进程正常事件循环，仍在相同原生菜单边界注入较新的显示／隐藏命令。相同驱动对照中，旧包四项全部失败，新包连续三轮共 **12 项通过**（`test-results/issue-11-menu-dispatch-old.json`、`test-results/issue-11-menu-dispatch-new.json`）。这确认了调整没有绕过原菜单缺陷；原生 timer 异常的完整成因仍未确认。测试另补充超时清理，以及启动超时后资源迟到的回收；最终测试代码通过静态检查、两项代码审查，以及打包版四项定向回归（`test-results/issue-11-menu-driver-final-packaged.json`）。这些正常路径运行不等于已经动态复现每种迟到启动情况。

继续完整回归前，桌面工具于 2026-10-26 再次明确报告 Mac 锁屏且无法解锁。用户再次手动解锁后，使用既有授权的临时保持唤醒完成新候选整轮：**80 通过、0 失败、2 跳过**（34 个构建／文件组合，1482.93 秒，`test-results/issue-11-menu-fix-full.json`）。开发版 39 项通过、2 项仅打包版适用而跳过；打包版 41 项全部通过。菜单重入、大小／主交互、睡眠、渲染恢复和 Dock 恢复均包含在该整轮中。测试退出后已确认所属应用、测试运行器与保持唤醒进程均无残留，未修改持久安全设置。

这是新候选的本地自动回归通过记录，不代表 #11 全部验收完成。新资源基线仍待安排；真实 Dock 权限／轮廓、输入焦点、动作视觉、离线冷启动、系统矩阵与登录等独立门槛继续保留。新旧候选的哈希、定向结果和未通过项目分别保存在各自交付目录，不将旧包的 70／2／2 整轮结果记到新包，也不借用旧 CI。

### 资源采样与预算

`measure:resources` 使用独立临时偏好启动真实打包应用，依次记录自然活动、每两秒一次的点击互动、合成拖动、隐藏，以及持续自然活动。记录每秒实际姿态、可见性、Dock 状态和进程树；拖动丢失或隐藏恢复可见会使采样失败并保留已测数据。测试时应避免操作桌面或同时运行回归；不改变产品时钟、随机数、原生 helper 或系统权限。

CPU 由进程累计 CPU 时间差计算，100% 代表占满一个核心；包含仍存活的 Swift 子进程，采样间退出的短进程可能漏记。内存是进程树 RSS 求和，可能重复统计共享页，不是独占物理内存。Canvas 绘制间隔和 pointerdown 到下一次 drawImage 的时间用于诊断，不能当作屏幕掉帧或真实输入到显示的延迟；Playwright、取样和观察本身也有开销。报告明确保留耗电与显示掉帧为未测量项。

默认 300 秒增长观察只是短时基线，不足以判断长期泄漏；可用 `--growth-seconds 3600` 延长，不能将旧 #8 的“跳过 60 分钟”变成已通过。用户在本次实施中确认先测基线，CPU、内存、耗电、输入延迟、掉帧与长期增长的数值预算均待确认。在跨应用真实输入／焦点、完整动作视觉、系统矩阵、能耗及长期测量补齐之前，#11 保持未完成。

本机本次独立采样完成，共 513 个样本，应用退出码 0、未检测到所属进程残留。原始数据为 `test-results/issue-11-resources/resources.json`，包含应用／helper 哈希、运行版本、显示参数及逐秒数据。可见期间 Dock 一直报告 `Dock source suspended; waiting for updates`，隐藏期间为 `Stopped`；因此不能把此样本当作真实 Dock 持续捕获、攀爬时的完整成本。

| 场景         | 实测秒数／样本 | 平均 CPU（单核 100%） | RSS 起点 → 终点／峰值（MiB） |
| ------------ | -------------- | --------------------- | ---------------------------- |
| 自然活动     | 60.0／57       | 4.42%                 | 627.8 → 570.9／634.0         |
| 每两秒点击   | 60.1／57       | 4.62%                 | 599.7 → 537.8／608.0         |
| 持续合成拖动 | 60.2／57       | 4.70%                 | 551.8 → 540.2／552.1         |
| 隐藏         | 60.2／57       | 0.45%                 | 514.5 → 507.0／514.5         |
| 继续自然活动 | 300.3／285     | 2.92%                 | 548.5 → 497.0／564.7         |

仅汇总区间两端动作 ID 与可见性都未变化的样本，稳定休息为 3.36% CPU（160 样本）、睡眠为 2.64%（166 样本）；行走只有 2 个稳定样本，不能据此设预算。隐藏阶段 0 次 Canvas 绘制。29 次驱动点击的 pointerdown 到下次 drawImage 的 p95 为 23.1ms，这是绘制诊断，不是真实输入到屏幕显示的延迟。RSS 是包含共享页重复计数的进程树合计；短时回落也不能据此断言无泄漏、低功耗或预算达标。
