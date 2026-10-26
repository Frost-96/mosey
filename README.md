# Mosey

一只生活在 macOS 桌面上的柯基。它会自主活动、睡觉，并对点击和拖动作出反应；日常运行离线、静音，无账号或在线 AI。

## 开发与运行

在 Apple Silicon Mac 上准备 Xcode Command Line Tools，并使用 [package.json](package.json) 指定的 Node 和 pnpm 版本：

```sh
pnpm install --frozen-lockfile
pnpm start
```

开发启动和打包会自动生成角色图集、编译并签名 Swift 辅助程序。完整命令见 `package.json`。

```sh
pnpm check
pnpm package:mac
pnpm test:dev
pnpm test:packaged
```

打包应用位于 `out/Mosey-darwin-arm64/Mosey.app`，可从 Finder 打开。构建下限为 macOS 15，仅做本地 ad-hoc 签名；经验证的系统范围与剩余交付事项见 [#11](https://github.com/Frost-96/mosey/issues/11)。

测试使用真实 Electron 窗口，运行时避免同时操作测试桌面。截图和报告输出到忽略的 `test-results/`。原生辅助程序回归与资源测量入口：

```sh
pnpm native:build
python3 tests/native/test-dock-live.py build/native/dock-live
pnpm measure:resources --seconds 60 --growth-seconds 300
```

资源测量支持 `--app /绝对路径/Mosey.app` 和 `--output test-results/新目录`；输出目录必须尚不存在，避免覆盖证据。报告记录包与测量工具的哈希、进程成本、Dock 捕获状态和每分钟的持续运行数据，每 30 秒保存一次原始样本。测量完成不代表性能达标；无有效 Dock 捕获时不能据此判断 Dock 交互成本，预算与验收结论仍记录在 #11。

## 使用与权限

菜单栏 🐾 提供设置、显示／隐藏和退出。关闭设置窗口后宠物继续运行；隐藏意图跨重启保留，重开后没有角色时先检查菜单栏。开机启动在设置中启用，状态以 macOS 实际设置为准。

Dock 交互需要当前应用启动链的屏幕录制权限。应用不会主动申请或修改权限；需要时在系统设置中手动授权，再选择 **Retry Dock interaction**。重建、重签或移动应用后应重新核对权限。捕获不可用时宠物仍可在地面活动，菜单栏提供状态与诊断入口。日志位于 `~/Library/Logs/Mosey/main.log`。

透明区域穿透仍有快速移入时首次点击的时序风险；点击宠物后可能需要重新点击工作应用以恢复键盘输入。完整的真实桌面、视觉、登录和性能验收继续由 [#11](https://github.com/Frost-96/mosey/issues/11) 跟踪。

## 项目资料

当前实现以源码、测试和配置为准。术语见 [GLOSSARY.md](GLOSSARY.md)；架构取舍保留在以下 ADR：

- [使用 Electron](docs/adr/0001-use-electron.md)
- [语言、动画与行为边界](docs/adr/0002-desktop-pet-architecture-boundaries.md)
- [Dock 原生桥接与权限边界](docs/adr/0003-dock-native-bridge.md)

待办与历史记录保存在 [GitHub Issues](https://github.com/Frost-96/mosey/issues)，仓库不维护已完成功能的镜像规格或验收流水账。
