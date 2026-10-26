# 使用 Electron 构建桌面宠物

首版在 macOS 运行，并保留未来扩展到其他系统的空间。用户在比较 Tauri、Electron、Qt 和 Swift/AppKit 后明确选择 Electron。采用 Electron 承载窗口与本地运行环境，行为逻辑和二维角色素材尽量跨平台复用；Dock、工作区和系统输入行为保留平台适配边界。

这个选择接受 Chromium 与 Node.js 的运行时成本，以获得统一的 Web 渲染环境和 JavaScript/TypeScript 开发路径；资源预算以实际测量为依据。与依赖系统 WebView 的方案相比，统一渲染环境减少了引擎差异；与纯 macOS 原生方案相比，保留了行为与素材的复用方向，但不承诺其他平台的窗口行为等价。透明区域命中、拖动捕获和 Dock 检测仍需平台实现及真机验证。
