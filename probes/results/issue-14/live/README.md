# ScreenCaptureKit 实时与独立应用试验

日期：2026-10-20。用户已明确接受屏幕录制权限作为候选，要求继续实时和打包验证；这不锁定最终桥接，也不是代替用户开启系统权限的授权。系统仍为 macOS 27.0.1、arm64，主屏1470×956点、backing scale 2。独立原生探针不代表最终 Electron 应用。

## 实时宿主观测

- [host-hidden-initial.jsonl](host-hidden-initial.jsonl)：从隐藏 Dock 启动，配置独立窗口流成功，但只观察到1次非完整回调，没有完整像素帧。没有把无帧解释为全透明像素。这是早期开发构建，不能反推其未记录的状态码。
- [host-shown-initial.jsonl](host-shown-initial.jsonl)：显示 Dock 后，3.33秒内取得1次完整帧、15次idle。BGRA图像2940×1912，带真实透明区域；frameScaleFactor=2、contentScale=1、contentRect=(0,0,1470,956)。该帧处理约9.12毫秒，从源displayTime到处理结束约15.30毫秒；仅一次帧的诊断，不是输入延迟或产品预算结论。早期开发构建尚未加入最终的全部计数／覆盖线字段。
- [host-hide-cycle.jsonl](host-hide-cycle.jsonl)：后续带实时覆盖线的构建运行25.24秒，interval=0.1、诊断max-frame-age=5。共114次回调：3次complete、110次idle、1次suspended（状态码3）；处理2次完整帧，因单帧忙门跳过1次。初始主体像素范围(291,1744,2358,158)，隐藏动画中实际取得范围(291,1794,2358,118)，随后suspended使候选失效，不保留旧线。后续没有新回调；这不是继续生成全透明完整帧。

实时青色轮廓与真实Dock圆角上缘在本机截图对齐；隐藏截图中线消失。图片仅保存在本地，未加入Git或上传。5秒是该次试验明确指定的诊断年龄截止，不是获确认的产品延迟预算；静止idle不更新历史完整帧的displayTime。当前保守失效策略也不是最终站位策略。

`displayTime`以mach ticks记录，通过实测timebase125/3换算；日志分别保留源、回调到达、处理起止时间。不将idle当成新像素，也不声称观察到了上游所有掉帧。

## 原生组件资源快照

[host-hide-cycle-resource.txt](host-hide-cycle-resource.txt) 来自 `/usr/bin/time -l` 同次运行：wall25.25秒、user0.20秒、system0.12秒，最大resident set为73465856字节，peak memory footprint为66798456字节。这次主要是静止与一次隐藏过渡，只处理了2次完整帧；没有测持续放大负载、GPU／WindowServer成本、能耗或最终Electron整应用，不据此宣称低功耗或性能达标。

## 独立应用身份

本地应用位于 `/Users/frost/.codex/visualizations/2026/10/20/01a15879-c49a-7f92-b301-cefd8f66a866/MoseyDockLiveProbe.app`，原生CFBundleExecutable，无shell启动包装。标识为 `local.mosey.dockliveprobe.experimental`，arm64、优化构建，API编译下限macOS15，实际只测试当前macOS27。ad hoc签名没有TeamIdentifier，不证明正式分发、hardened runtime或公证可用。

- 首次独立启动的[日志](app-build1-ungranted.jsonl)与[签名](app-build1-signing.txt)证实其bundle标识、parentPID=1、权限不足且没有发起shareable-content查询。该构建存在AppKit启动生命周期缺陷，桌面工具未能找到正常运行窗口；缺少末尾summary不能称为正常退出通过。后续已改为同步入口、NSApplication.run与didFinishLaunching启动异步任务。
- 最终冻结构建的[日志](app-frozen-ungranted.jsonl)与[签名](app-frozen-signing.txt)：CDHash `31649c91cdd82f33784de8b7157f4f451e894aab`。真实桌面工具已读取到“Mosey Dock Live Probe”窗口及BLOCKED文字，明确无屏幕录制授权、未请求权限；没有采集流。随后由用户手动授权；复验保持同一份文件和签名。

- [app-frozen-granted-show-hide-quit.jsonl](app-frozen-granted-show-hide-quit.jsonl)：用户授权后，系统设置读回该应用开关为on。通过LaunchServices重新启动，parentPID=1、相同bundle路径，窗口显示CAPTURING。25.35秒内70次回调（6次complete、62次idle、2次suspended），3帧分析、2次忙门跳过、1次间隔跳过。完整帧包含真实全透明帧、显示主体(227,1744,2486,158)以及隐藏动画主体(227,1764,2486,148)。suspended后候选失效。点击真实Quit按钮后日志写出completed summary，桌面控制返回procNotFound；未把该返回误记为采集失败。默认1秒年龄门限会使静止idle后的历史轮廓过期，不是可用于站位的最终策略。

- [撤销后重启](app-frozen-revoked-relaunch.jsonl)：用户手动关闭该应用屏幕录制权限，系统设置实际读回off。同一冻结文件重新启动，窗口显示BLOCKED；日志明确`shareableContentQueryAttempted:false`，没有stream_configuration或frame，Quit后summary为permission_unavailable。签名再次核对仍为上述CDHash。读取退出后UI时桌面工具又启动了一次应用，形成[第二次重启](app-frozen-revoked-second-relaunch.jsonl)，结果一致，并再次通过Quit结束。代理没有重新授权。

撤销操作对应的采样轮次此前已经120秒到期，故仅验证了撤销后重启，不证明运行中撤销的错误通知、系统终止行为或清理时序。上述结果也不能称作用户在授权提示中点击拒绝。

这已直接证明宿主可采集不等于独立.app获得授权；应用重建会改变ad hoc身份，因此此次授权验证期间不重建或移动该文件。

## 代码检查与待验收

三个历史探针的既有检查保留。本轮新增真实进程CLI检查，包括无授权时不查询SCK、参数边界、保护既有日志文件，以及预先填满stdout管道后仍在duration+10秒内硬退出。审查发现watchdog可能被同步日志锁阻塞，已改为任何UI／日志前启动、独立`_exit(124)`；回归测试红→绿。硬退出可能没有summary，必须以退出码124识别。

Standards未发现文档规范违反；提出一项P3维护建议：PNG与CVPixelBuffer探针各自实现阈值／连通分量算法。目前保留两个实验入口，避免在桥接尚未锁定时扩大构建结构；这不是正式适配的共享模块设计。若采用该路线，应统一分析内核或建立同输入对照，不能默许两者语义长期分叉。Spec审查的P2和AppKit生命周期问题已修复并复核。

尚未验证：采集中撤销／提示中拒绝、实时放大与侧边组合、Dock进程／显示配置变化、最终Electron身份与打包、长期资源与延迟预算。#14保持OPEN；不声称攀爬完成或已选定正式桥接，不引入固定边界降级。

## 再授权后的放大与实时侧边轮次

用户手动重新开启同一冻结应用权限，系统设置读回on。本轮没有重建应用。底部[应用日志](app-frozen-magnification.jsonl)运行120.16秒：393回调，106 complete、286 idle、1 suspended；分析76帧，间隔门限跳过30帧，无忙门跳过。首个分析帧约80.23秒，末个约92.10秒；75帧有主体。主体宽度2572–2618像素、顶部y=1730–1752，并非始终保持y=1744。用户回复“完成”，未单独确认放大幅度；本地隔离图实际显示悬停放大的图标与分离标签。本轮的隐藏操作没有在应用到时前产生新的suspended，不能把120秒结束视作隐藏验证。

[数值汇总](magnification-and-sides-summary.json)记录截图SHA-256及轮廓摘要。悬停稳定后`100.png`的最大分量范围(161,1744,2618,158)、411792像素、逐列轮廓FNV `cbb7e31dbf8d4f91`，与最后一个实时分析帧完全一致。原始全alpha范围顶部为1660，包含提示标签；最大分量排除本图分离标签。该截图晚于实时帧，不是同步动态误差或输入延迟测量。截图采集的单调时钟开始／结束及返回码另见[capture-times](magnification-capture-times.jsonl)和[补充段](magnification-capture-times-extra.jsonl)，图片仅在本地。截图采集本身也可能影响负载，不能用这一轮宣称纯SCK性能。

随后在已授权CLI宿主运行左右各30秒的独立流；这些记录的身份与.app分开，不把CLI权限结果冒充应用自身授权。

- [左侧](host-left-show-hide.jsonl)：118回调（6 complete、110 idle、2 suspended），3帧分析，3帧因间隔门限跳过。显示过渡中分析主体x=7、y=140、宽118、高1700；稍后本地静态截图稳定x=9，轮廓哈希不同，存在2像素差异。隐藏过渡中分析x=1，随后suspended使候选失效。不能把左侧整段称为精确对齐通过。
- [右侧](host-right-show-hide.jsonl)：115回调（6 complete、107 idle、2 suspended），4帧分析，2帧因间隔门限跳过。显示稳定帧(2813,140,118,1700)、199724像素、逐行内侧轮廓FNV `28c7871aea87c6fb`与本地截图一致；隐藏过渡x=2815，随后suspended失效。

本轮确认了两个待修问题：静止且持续idle时，当前源帧年龄策略仍会使正确轮廓过期；完整帧的本地间隔门限可能跳过动画末帧，左侧差异与此相容，但尚不能仅靠日志确定因果。后续先修复诊断流的最新帧保留和idle有效性，再复验，不将其当作正式站位策略。结束后设置实际恢复底部、自动隐藏on，大小与放大滑块保持原值。
