# 使用 Electron 构建桌面宠物

首版在 macOS 运行，并保留未来扩展到其他系统的空间。用户在比较 Tauri、Electron、Qt 和 Swift/AppKit 后明确选择 Electron。采用 Electron 承载窗口与本地运行环境，行为逻辑和二维角色素材尽量跨平台复用；Dock、工作区和系统输入行为保留平台适配边界。

这个选择接受 Chromium 与 Node.js 的运行时成本，以获得统一的 Web 渲染环境和 JavaScript/TypeScript 开发路径；实际内存、CPU 与耗电仍需测量。透明区域命中、拖动捕获和 Dock 检测不会因选型自动解决。原生探针的结果也不能视作 Electron 已验证通过。
