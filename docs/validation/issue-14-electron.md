# #14：正式 Electron 环境中的 Dock 实验

## 范围与运行入口

使用现有 Electron 44.9.1、Forge 8.0.1、Vite 8.3.4、TypeScript 6.0.3、Zod 4.6.7；没有升级依赖。`pnpm start`、`pnpm package:mac` 和整应用测试仍是正式入口。旧 `probes/electron` 不是本次宿主。默认应用不启动原生捕获；待机素材、单实例、退出和安全 renderer 配置保持原有验收。

菜单栏和应用菜单的 **Dock validation** 共用同组操作：启动一次 120 秒验证、停止、打开状态窗、人工选择 bottom/left/right。方向仅是操作者标签，不代表自动识别了系统设置。状态窗是无 preload、无脚本的 sandbox 页面；主进程只展示验证后的原生报告，不在 renderer 计算或补造边缘。所有结果仍 `supportEdge: null`；没有宠物攀爬、碰撞接口、固定 workArea 替代、守护程序或公开插件。

## 构建、资源与签名

`tools/build-dock-helper.ts` 用当前 Xcode Swift 编译 `probes/dock-live.swift`：`-O -target arm64-apple-macos15.0 -parse-as-library`，再进行本地 ad-hoc 签名。macOS 15 是此实验 helper 的 API 编译下限，不是已确认的产品最低版本。源代码沿用最新完整帧调度、最大连通分量与显式 idle-current 诊断策略；只增加 `--no-app-status`，强制子进程以无原生窗口的 CLI 模式运行，不受 Bundle.main 推断影响。之前冻结的独立 Swift `.app` 未重建或移动。

开发路径是项目 `build/native/dock-live`；打包路径固定为 `Mosey.app/Contents/Resources/native/dock-live`，位于 asar 外。Forge 的 `osxSign` 自动发现并签名嵌套 Mach-O，使用 `identity: "-"`、关闭证书身份查询与自动 provisioning，时间戳为 none，不使用 blanket `codesign --deep` 签名。helper 标识为 `dev.frost.mosey.dock-helper`，顶层应用仍为产品 **Mosey / dev.frost.mosey**。本地实验未开启 hardened runtime，没有 Developer ID、TeamIdentifier、公证或权限持久性保证。

资源同时包含严格校验的 `receipt.json`，记录源码 SHA256、优化编译参数、Swift 版本、构建阶段二进制哈希及签名信息。Forge 重新签名后 helper 字节可能不同，因此运行日志另记实际 helper SHA256 和实际顶层/嵌套签名，不能把构建哈希冒充最终签名产物哈希。不要在授权后重建、重签或移动冻结产物；如需修复，应另行记录新身份和重新验证。

## 进程、协议与容量

主进程使用固定 helper 路径和固定参数直接 spawn，不经过 shell。原生 duration 为 120 秒、interval 为 0.1 秒、启用 `--idle-current`；该 currentness 是在新鲜 idle 回调下保留最后完整帧的实验判断，原始像素时间戳不刷新，也不成为产品支撑边缘。Swift preflight 不通过即输出 unavailable 和 `shareableContentQueryAttempted: false`，不调用 SCK 查询。Electron `getMediaAccessStatus("screen")` 单独记录，只是宿主诊断信息。

stdout 经 UTF-8 流式解码、每行 64 KiB 限制和 Zod 严格联合协议校验；首记录必须是环境，原生 PID、父 PID、方向必须与本次真实 spawn 一致。非有限数字、未知字段/类型、超长/残缺记录或错误状态使实验 fail closed，停止原生进程。像素只留在 native 内存，跨语言只传数字/状态摘要，不写图片，不自动联网或上传。

日志位于 Mosey userData 的 `dock-validation/run-UUID.jsonl`，文件权限 0600，每次最多 8 MiB，最多保留三次运行。首记录包含 Electron/Node/应用版本、打包/开发路径、PID 与父 PID、实际签名、helper receipt/hash，以及 Electron 主屏 id/bounds/scaleFactor；workArea 明确标为 diagnostic only。原生记录保持原始 mach/elapsed 信息，包装层另记自身 monotonic 接收时间，不能把两个时钟假定为同一 epoch。日志没有可靠证据时不补造 native 完成记录或几何。

Electron 另有 125 秒结束期限，停止时先 SIGTERM，1.5 秒后对同一个已捕获的 child 实例 SIGKILL；每次运行重置定时器和原因，等待 close 再允许新的运行。停止、退出应用、系统 suspend 都清除当前性并清理子进程；resume 不自动捕获，用户必须明确重启。原生自身另有独立硬截止，但不能替代宿主清理。

## 传输与 currentness 边界

宿主对验证后的 heartbeat 有独立 2 秒接收期限，启动阶段为 10 秒。超过期限会显示 Failed/Unavailable 并结束子进程；不会无限保留上次 “current” 标签。heartbeat 的原生 elapsed 必须递增；宿主以环境记录接收时刻为自身 monotonic 锚点，拒绝后续相对进度落后超过 2 秒的报告，以避免暂停后消费旧缓冲又暂时恢复 “current”。这只是相对传输滞后的诊断下界；初始 environment 本身若已缓冲，不能据此证明绝对传输延迟。界面标为 “Latest validated native currentness”，不把接收时刻当像素新鲜度，也不宣称鼠标输入延迟或产品预算达标。

## 验证与身份归属

在已确认的整应用外部边界运行 Vitest + Playwright，真实启动正式开发/打包入口。原有可见像素、动画变化、preload 隔离、单实例和应用菜单退出断言继续运行。新增流程经用户菜单启动，读取可见状态窗与真实本地日志；Failed 不作为成功 readiness。blocked 分支要求原生 unavailable/no-query 且没有 stream 配置。

获得真实捕获时，测试只对日志中该应用验证过的 native PID 发送 SIGSTOP：第一次观察传输过期/Unavailable 和清理，第二次重新启动后 Stop，第三次重新启动后 Quit；每次从 OS 观察进程已退出。没有 grant 时只验证 blocked/退出，把活进程故障注入明确记为 skipped，不伪报已测。三次运行的数字日志会复制到 `test-results/{development|packaged}-dock-run-N.jsonl`，避免应用三份保留策略删掉前一模式的证据。

Playwright 启动的 Electron 或打包应用仍可能继承执行宿主责任链；其捕获成功不证明 Finder/LaunchServices 独立启动同一应用已获权限。必须冻结最终 `.app` 后，由独立启动记录顶层和 helper 路径、PID/父 PID、实际签名以及 native preflight/SCK 结果，再在需要时请用户手动配合。不能从父子关系规则或 Electron 的状态值推导 Screen Recording 的实际 TCC 归属。底部/侧边 Dock、放大/tooltip、隐藏和授权撤销的物理验证由实际桌面操作补齐；原生实验成功也不等于 Electron 产品攀爬完成。

独立原生历史探针与原始证据 `probes/` 使用其自身编译/CLI/物理检查，不进入正式 TypeScript/Prettier 格式边界；没有批量重写旧原始数据。应用 `src/`、tests、tools 和构建配置仍全部执行 typecheck/lint/format。

## 第一版自动化结果（2026-10-20；后续独立启动发现缺陷）

macOS 27.0.1、Apple Silicon：`pnpm check` 通过；最终开发整应用测试 1/1（8.19 秒），最终签名打包测试 1/1（6.59 秒）。两种模式每次均真实进入 native stream 配置，三次运行均完成对自有 helper 的 SIGSTOP 故障注入：传输过期清理、重复 Stop 清理、Quit 清理。每次 helper 已从 OS 进程表消失，应用退出码为 0；不把开发/Playwright 的继承权限写成独立应用授权。

最终候选产物在本票工作树 `out/Mosey-darwin-arm64/Mosey.app`。`codesign --verify --deep --strict` 通过（这里只是递归验证，不是 blanket deep 签名）。实际顶层标识 `dev.frost.mosey`、CDHash `3ea5bd0347ae7f8153054afaebeb1bffee947ae4`；嵌套 helper 标识 `dev.frost.mosey.dock-helper`、CDHash `36c9fcca331ba218d10eb0ae0e101c76ae73e20d`，均为 ad-hoc，TeamIdentifier not set。helper SHA256 `31c2e44db610009c9a38618fff72fcda3aa4f12d4bfc511695783a070b76cd63`；app.asar SHA256 `93a8d5fa951ce50379aeffa21cb93ea8a9698bec015f92e97bd06c0f2f58e11c`。

本地完整签名/哈希/编译 receipt 保存于 `/tmp/mosey-electron-dock-final-provenance.json`；两模式各三份数字日志和生命周期摘要在该工作树 `test-results/`，不会随应用 userData 的三份轮转丢失。未把截图或 native 像素放入此票证据。最终独立 LaunchServices 启动、必要的手动授权与真实 Dock 动态比较仍由操作者在冻结产物上执行；此自动化结果不替代那些证据。

## 独立启动缺陷与第二版修复（2026-10-20）

第一版的独立 LaunchServices 启动停在主进程，没有 renderer，也没有新的启动日志；本地 sample 显示 NSAlert modal，但 stdout/stderr 没有提供异常文本，因此不引用未经观察的错误消息。冻结的第一版副本保持原样，尚未请求用户授权。

外部整应用回归不使用 Playwright inspector：把实际打包 app 复制到临时目录（开发 checkout 及其 node_modules 之外），以 cwd `/` 和仅 HOME/PATH/TMPDIR 的环境启动真实 executable，要求它创建 renderer，再仅终止该测试拥有的进程。原始 out 路径通过约 0.7 秒；冻结副本和自动临时副本均在 8 秒无 renderer 失败。提前访问 powerMonitor 的假设经单变量修复实验仍失败，已撤回。

已确认 app.asar 第一版没有 node_modules，而 main.mjs 保留外部 `electron-log/main` import。原 out 路径能向祖先开发目录解析该包，独立副本不能。Forge Vite 默认只复制 .vite，因此现显式保留 .vite、package.json 和锁定的 electron-log 5.4.4 运行包；不改变依赖版本，不依赖宿主 Node/npm，不将 CommonJS logger 盲目打入 ESM。其包没有传递运行依赖，其余应用依赖已由 Vite 打包。第二版 asar 内有 52 个 electron-log 路径条目。仅此打包修复后，同一独立回归通过约 2.49 秒。

正常 packaged 验收也改为从临时副本运行，继续验证可见宠物、动画、安全隔离、单实例、菜单和三次 native 生命周期。最终 `pnpm check` 通过；开发 1 个通过、独立打包专属回归跳过（8.42 秒）；打包 2 个通过（8.02 秒）。两模式三次运行均实际 capturing，并执行自有 helper SIGSTOP / 传输过期、重复 Stop、运行中 Quit 清理，未跳过活进程路径。数字日志仍在 test-results；这不证明独立 LaunchServices 的权限责任归属。

第二版实际顶层 CDHash `260b3a02cbd27ff5eadfb16d96b0b0bb34359374`；helper CDHash `36c9fcca331ba218d10eb0ae0e101c76ae73e20d`。asar SHA256 `e4c4b2375c6cae151bc8cd10c163842563982c2c66aec58ffda9cb6fcbdc6cd7`。递归 strict 签名验证通过；完整签名、哈希、编译 receipt 另存 `/tmp/mosey-electron-dock-v2-provenance.json`，第一版 provenance 不覆盖。第二版冻结后仍需实际 LaunchServices 启动/可见菜单/必要手动授权验证；不把这个无 inspector 的子进程测试冒充 LS 独立责任链。
