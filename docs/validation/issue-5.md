# Issue #5 — 睡眠与唤醒

基线为 `7d34491`，包含 #15 自由活动、#9 大小、#22 本体菜单。仅扩展原有纯 TypeScript XState 行为，不另建一套自由活动调度。整应用外部行为仍是父规格确认的统一测试边界；Vitest 运行器配合 Playwright Electron API 驱动真实应用，不测试私有状态字段或计时器次数。

## 行为与调优

自由活动沿用休息18–32秒、短距离散步／伸展／自己玩。一次清醒周期达到120秒后，在下一次稳定休息的调度点躺下入睡，不打断正在完成的活动。入睡880ms，睡眠呼吸循环1800ms；第一次点击只耳动500ms，900ms内第二次点击才播放1000ms起身。参数属于可调实现值，没有新增设置。入睡过程中点击可中止入睡；睡眠、耳动、起身以及原有动作始终可被拖动打断。

耳动动画结束不清除第一次点击；500–900ms之间的第二次仍有效。过了900ms的点击重新视为第一次。睡眠路径独立于清醒点击350ms合并规则，快速第二次不会被吞掉。起身时的额外普通点击不排队。拖动沿用原有扑腾／下落／落地，释放不额外逗弄。

原有 `Timeline` 同时负责行为计时、动画和位移；本体菜单打开冻结当前动作和睡眠点击窗口，右键不计普通点击。隐藏、系统暂停及恢复取消瞬态，恢复稳定休息并重新开始清醒周期，旧完成通知受 actionId 约束。修复原有恢复显示时无条件横向居中的行为：保持当前x，并按当前主屏约束和地面对齐，避免睡眠隐藏／显示时突然横移。配置仍只保存大小与隐藏意图。

## 素材与视觉处理

素材由内置 imagegen 在制作阶段生成；运行时离线，不调用AI。最终源图：

- `src/assets/corgi-sleep.png`：生成记录 `exec-aaea1ede-4629-4774-b706-78552ec678a5.png`；四格依次为呼气、吸气、耳朵微动、单耳放低，全部闭眼。睡眠与耳动共享这张图。
- `src/assets/corgi-wake.png`：生成记录 `exec-25c7dfea-99fd-41c1-862f-a573582a2008.png`；依次为困倦趴卧、抬头、前半身起立、站立。反向播放用于躺下，起身末帧接入原待机像素。

最终提示词组：以原柯基作为身份参考，保持橙／奶白毛色、白色额纹、短腿、粉耳、右朝向与同一尺寸，四格2×2动作表；睡眠0/1呼气吸气、2/3只动近侧耳且眼睛始终闭合；唤醒从困倦趴卧到抬头、前半身站起、完全站立，压短躯干并接近原待机比例；无文字、道具、阴影或地面，透明背景。选定睡眠源图另经同一内置工具做背景抠除，提示为：

> Remove ALL the brown/black glow and ground shading and shadows surrounding these four corgis. Output a clean 2x2 sheet with ONLY four corgi silhouettes, transparent everywhere outside their bodies, NO shadows, NO glow, NO background color. Keep orange fur cream white paws, brown outlines, pink ears fully opaque inside each character. Preserve exactly these four poses and their placement at same scale. Hard clean alpha cutout edge, zero halo, suitable for compositing on any desktop wallpaper. Do not change body identity or poses. Truly transparent PNG.

源图由 `tools/build-assets.ts` 可复现切帧、清理alpha<128并生成命中行。唤醒源图没有遵守等高网格，中间透明行位于y460附近，因此明确按y460切两行，避免y512切断耳朵；x仍等分。睡眠／耳动／躺下／起身共用固定水平与垂直校准，站立目标420×394px，最宽趴姿限制474px；各姿势之间不独立缩放。以 `fit: "fill"` 执行这一明确的双轴校准，避免sharp默认cover把鼻子、尾巴裁断。所有图集仍为480²的2x单帧、底部中心(240,480)锚点和同源alpha命中。

已检查真实Electron Canvas的240 CSS px截图：脸、额纹、毛色可识别，睡眠闭眼、耳动仍闭眼、起身睁眼，鼻尖／尾巴／耳尖完整，脚底对齐，外部透明。静态截图只能证明这些姿态，动态衔接和真实输入另留桌面验收，不能仅凭图集元数据声称自然度通过。

## TDD与自动化证据

三轮明确的行为RED→GREEN日志位于本机 `/private/tmp/mosey-5-*.log`：

- `red`：未实现睡眠时，短暂伸懒腰也会低头，但无法维持2.6秒的低睡姿，出现163.5px而要求<160px。排除只看到一帧低头的假阳性。
- `click-red`：只实现睡眠后，第一次点击像素仍属于睡眠循环，耳动断言失败；增加耳动／起身与独立点击窗口后同一路径通过。
- `position-red`：睡眠在x20隐藏，显示后跳到x615；改为保持当前位置并约束主屏后通过。中途一次测试变量缺失和一次原生菜单自动取消未计作行为RED。

新增用例覆盖：持续睡眠及呼吸变化、首击耳动、350ms内快速第二次、耳动完成后的650ms第二次、超窗重新首击、菜单暂停1.2秒、睡眠／耳动／起身拖动、落地后真正待机像素、隐藏与恢复无横移、模拟系统暂停／恢复无过期动作与位移。用实际Canvas像素和窗口位置判断结果；没有新增产品测试开关。

测试仅在系统边界将长休息定时缩短为500ms，并同步推进主进程与渲染器Date.now以跳过120秒清醒等待；动作帧、900ms点击窗口、拖动及落地使用真实经过时间。鼠标是Playwright定向窗口输入。系统休眠由Electron suspend/resume事件模拟，不能替代物理机器休眠。菜单组合场景使用公共Menu边界拦截操作系统跟踪，避免Cocoa在自动化中自行提前取消；原有context-menu套件仍实际打开原生菜单。完整首次运行曾在未拦截原生菜单时通过，重复运行出现提前关闭，因此不将该组合场景宣称为稳定真实桌面结果。

测试失败保留截图，所有应用、Forge进程及临时配置在finally清理。最终结果见下节。

## 最终本机验证 — 2026-10-21

环境：macOS27.0.1（26A434）、arm64，开发Node24.18.0、pnpm12.11.2，Electron44.9.1。未据此扩展最低系统或其他硬件声明。

- `pnpm check` 通过，包括strict类型、ESLint与Prettier；`git diff --check` 通过。
- 完整开发套件234.85秒：6文件通过，size-autonomy一项失败，另有开发模式预期跳过的无inspector打包启动用例。失败明确是测试在上一个拖动后把宠物留在x0，却仍要求向左移动：实际x148而要求<-15。新显示恢复语义保留x，既有边界规则正确向内转身。测试现在在要求定向行走前，公开摆放窗口到屏幕中部；所有位移、方向、命中、缩放及拖动断言保留。修正后size-autonomy与新增sleep两项定向开发测试均通过，97.32秒，见 `issue-5-development-targeted.log`。
- `pnpm package:mac` 成功，产物 `out/Mosey-darwin-arm64/Mosey.app`。
- 完整打包套件203.85秒：6文件／7项通过，包含新增睡眠、既有点击、隐藏恢复、大小、菜单、自由活动及无inspector启动。size-autonomy在首个Large拖动中观察到持住窗口y536→656，失败于原有1.6秒持住断言，见 `issue-5-packaged-full.log`。临时只读公开输入／窗口事件观察的独立运行未复现（48.83秒）；移除全部临时观察后，原断言的干净独立运行也通过（48.86秒），见 `issue-5-packaged-size.log`。没有改动产品拖动处理，没有删除或放松持住断言。

这不是“完整套件一次全绿”的记录；全部用例在上述完整与定向运行组合中通过。一次持住失败的因果未被捕获，不能断言是物理鼠标、驱动、焦点或产品逻辑导致。此前 [#9验证记录](issue-9.md) 的“Mainline autonomy and display-recovery integration — PR26”段也记录同类未定位的持住失效；本次保留为真实桌面输入及自动化稳定性的限制，不宣称已修复。所有 `[DEBUG-5-capture]` 临时观察均已移除。

`issue-5-{development,packaged}.json` 保存实际快速第二次点击间隔、观察到的睡眠像素帧数及证据边界。最终截图 `issue-5-breathing.png`、`issue-5-ear.png`、`issue-5-waking.png`、`issue-5-standing.png` 来自最终打包应用240 CSS px（Retina480px输出），已逐张查看完整轮廓和锚点。原有动作图集的PNG／JSON字节未改变。

## 仍需独立桌面证据

默认约两分钟节奏下的动态衔接、真实鼠标的睡眠两次点击／拖动，以及让Mac实际睡眠再唤醒，仍需在最终打包应用上操作并记录。自动化的时间压缩、定向输入和模拟系统事件不能替代这些事实。尚未宣称物理休眠、所有显示缩放、全部macOS版本或长期资源预算通过。

## 最新主线集成与初始显示修正

实现提交后并入 `01bb95e` 的 #10 系统登录启动成果。在这一打包环境重跑时，新增睡眠测试在任何时间压缩或输入前观察到Canvas持续为空（见 `issue-5-startup-red.log`），不是睡眠状态断言失败。新鲜独立应用的公开边界连续3.5秒观测显示：原生窗口实际可见、document未隐藏，Canvas仍无不透明像素；公开表现请求仍返回hidden。菜单操作确实使原生isVisible在false／true之间改变，但未观察到相应show／hide事件，原表现状态也未跟随。没有将这解释为已确认的素材解码延迟，也没有仅延长等待掩盖空画面。

现在通过同一幂等函数，在原生show／hide事件和应用显式启动、隐藏、恢复后对齐真实窗口状态。隐藏意图仍优先，重复或迟到的通知不重置正在进行的动作与点击窗口。保留原输入、隔离和偏好边界。测试仍断言真实Canvas可见；仅初始准备阶段采用5秒上限，900ms点击窗口、各动作和位移期限未放宽。

最终检查与产物：`pnpm check` 通过；开发sleep与visibility两项通过（60.73秒）；重新打包成功；打包sleep、visibility与login-items三项通过（56.65秒），登录启动测试恢复not-registered且cleanupErrors为空；最后原生context-menu打包回归通过（27.16秒）。对应记录为 `issue-5-final-development.log`、`issue-5-final-packaged.log`、`issue-5-final-menu.log`。四张最终打包截图及development／packaged睡眠JSON同步为这一最终产物的结果。

前节完整套件与size-autonomy定向运行发生在这一显示修正前；最终变更后只重跑直接相关的睡眠、隐藏／恢复、登录菜单与本体菜单场景，未把旧完整运行描述为新提交的一次全绿。PR首次CI另在旧autonomy测试最后长按的精确待机像素集合断言失败，窗口位置保持；根代理正按实际截图与初始帧采集边界核对，尚不声称远程CI通过。

## CI待机像素基线的采集前置

PR首次CI的旧autonomy用例最后长按保持了窗口位置，却在精确待机像素集合断言失败。失败截图是不透明身体高201px的右朝向站立姿态，初始app截图为197px；二者分别对应原待机呼吸的不同高度。原CI没有保存被比较的Canvas基线，不能据此确认是漏采高呼吸帧，亦不能把“看起来像待机”替代精确像素断言。

采样现在先在真实Canvas观察到足量不透明身体（>5000像素、CSS身体高度>180），再开始原本完整的2200ms参考周期；networkidle不再被当作图片解码与首帧绘制完成。仍要求实际待机有像素变化，并保留原长按位置相等和精确待机集合匹配。每个原始及镜像参考Canvas输出保存为PNG，另存尺寸、非透明像素数与上下界；最终长按用于比较的原始Canvas也保存，便于下次CI区分漏帧、插值差异及真正错误姿态。默认强制1x以在本机覆盖CI栅格路径，可用MOSEY_TEST_SCALE_FACTOR=2验证Retina路径。没有新增或放宽产品动作逻辑。
