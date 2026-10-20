# Mosey

> 状态（2026-10-20）：#3 点击互动已按用户决定暂缓，此分支保留未完成的实验代码，不作为可用版本交付。当前实际运行恢复为已验收的 #2 纯待机（`integration/issue-2-formal-idle` @ `812c26d`）。私有 AppKit 焦点适配未合入本分支。

单只柯基的本地 macOS 应用（#13 工程基线、#2 正式待机、#3 清醒点击实现）。Canvas 2D 播放呼吸循环，点击可见身体时随机歪头、伸爪或翻肚，动作期间连点合并、不排队。240 × 240 点透明窗口放在主屏可用区域底部，菜单栏 🐾 提供 **Quit Mosey**。透明区域使用当前帧同源 alpha 切换鼠标穿透；8ms 光标轮询仍有首次进入竞态，真实跨应用首次点击、透明洞和工作应用焦点尚未通过验收。见 [#3 证据与限制](docs/validation/issue-3.md)。拖动、自主活动与 Dock 交互尚未实现。

## 运行与验证

在 Apple Silicon Mac 安装 Node **24.18.0** 与 pnpm **12.11.2**，然后：

```sh
pnpm install --frozen-lockfile
pnpm start
```

正式入口是根目录的 pnpm / Forge 流程；保留的 `probes/` 可独立运行，其 npm 入口不是正式应用入口。

```sh
pnpm assets:build   # sharp 制作图集、版本化描述及同源 alpha 命中数据
pnpm check          # strict TypeScript、ESLint、Prettier
pnpm test:dev       # Forge 开发服务器 + 真实 Electron
pnpm package:mac    # Forge + 官方 Vite 插件，构建本地 darwin-arm64 .app
pnpm test:packaged  # 启动刚生成的真实 .app
```

`pnpm build` 通过相同 Forge package 流程构建当前平台产物；本票交付与测试限定 macOS arm64。应用在 `out/Mosey-darwin-arm64/Mosey.app`，可用 Finder 打开。打包不签名、不公证、不自动发布；交付范围是本机验证。首次安装需要网络下载依赖与 Electron 二进制。

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

素材输入保留在 `src/assets/corgi-idle.png`。`tools/build-assets.ts` 使用 sharp 提取单一稳定姿态，制作同身份呼吸循环、2x PNG 图集及版本化 JSON；制作幅度、脚底锚点和透明边缘处理见 [#2 证据](docs/validation/issue-2.md)。`start` / `build` / `package:mac` 的 pre 脚本自动生成素材；生成物也提交，开发与打包均使用同一结果。开发由 Vite 提供图片 URL，生产通过 import 打包为带 hash 本地资源，随 asar 交付。

行为模块只依赖 XState 和 TypeScript，主进程分别管理姿态与系统可见性；renderer 按实际经过时间选帧，仅在帧改变时绘制，不可见时停调度。单实例锁在建立窗口／托盘之前获取；重复启动不激活已有窗口。日志只写本地 `~/Library/Logs/Mosey/main.log`，1 MiB 阈值与单份旧文件轮转，不上传，不开启逐帧日志。

## 验证记录与边界

2026-10-20，在本机 macOS 27.0.1（26A434）、arm64 上，先观察到打包程序尚不存在的真实启动失败，再实现并通过开发与打包整应用测试。测试由 Vitest 驱动 Playwright Electron API，检查单窗口、Canvas 超过 5000 个不透明像素、透明背景截图实际包含角色像素、连续截图变化、renderer 无 require、实际 preload 为 CJS，以及实际运行版本。通过应用菜单的 Quit Mosey 回调退出并等待进程 exitCode 0；finally 关闭应用、终止整个 Forge 进程组并清理临时目录。失败保存各窗口截图；成功截图与运行时 JSON 在 `test-results/`。

GitHub Actions 在官方 arm64 `macos-15` runner 上执行 frozen install、类型/lint/格式、真实开发测试、Apple Silicon 构建和真实打包测试，上传 app zip 与测试证据；失败不会跳过或伪报测试通过。本机结果不代表远程 CI 已运行，也不声明 macOS 15 已在本机验证。

#2 已接入 XState、受限 IPC、正式素材管线、单实例与本地日志，并扩展真实应用测试验证脚底与重复启动；本次记录见 [验证文档](docs/validation/issue-2.md)。真实桌面层叠、工作应用焦点、真实鼠标菜单栏退出及打包应用断网启动仍需独立证据。API 菜单回调不能替代真实鼠标验收，也不表示完整首版通过。

以下为 #13 工程基线历史记录，不作为 #2 新实现的通过证据：`pnpm check` 全部通过；清空 node_modules 后 `pnpm install --frozen-lockfile` 通过；开发整应用测试 1/1（1.70s），打包整应用测试 1/1（1.08s）。运行时 JSON 两种模式均为 Electron 44.9.1 / Node 24.22.0。打包截图已人工检查为完整、透明背景的柯基，无滚动条。测试后检查本工作树路径的进程列表，无应用或 Forge 进程残留。GitHub Actions 首次远程运行 [39397051399](https://github.com/Frost-96/mosey/actions/runs/39397051399) 在 setup-node 的自动包管理器缓存阶段失败：此时 pnpm 尚未安装，提示找不到 pnpm 可执行文件，后续应用检查均未执行。现已关闭 setup-node 的自动包管理器缓存，让锁定的 Node 先安装，再安装 pnpm；修复后的远程运行 [39397492660](https://github.com/Frost-96/mosey/actions/runs/39397492660) 全部通过，包括 frozen install、类型/lint/格式、真实开发测试、Apple Silicon 打包、真实打包测试和产物上传。
