# #4 回到底部素材

工具：内置 image_gen，`transparent_background=true`，以 `src/assets/corgi-idle.png` 为形象参考。本轮没有使用 API/CLI，也没有程序绘制或缩放待机图替代新增动作。生成源图保存到 `src/assets/corgi-return.png`（1254 × 1254 RGBA，四个 627 × 627 单元）。原始输出位于 `/Users/frost/.codex/generated_images/01a15ca6-798f-7090-8d92-30c5afbd354f/exec-29de7195-31c6-42f9-9157-4b9526d3e4a3.png`。

完整生成提示：

> Use case: identity-preserve. Asset type: desktop pet animation sprite sheet. Edit reference corgi into a 2 by 2 sprite sheet on genuine transparent background. Keep exactly the same orange-and-cream friendly illustrated corgi identity, brown outline, face, head proportions and right-facing three-quarter view. Four full-body poses, one centered in each quadrant, all with generous blank margins, no overlap: top left being picked up, body curled compactly and all four paws tucked, curious surprised face; top right airborne flutter with front paws stretched sideways and hind paws tucked; bottom left airborne flutter alternate beat with front paws raised and hind paws spread; bottom right landing crouch, belly low and all four paws touching a common horizontal baseline. Keep entire ears, tail and paws visible in each cell. Consistent character size and art style. No ground, shadow, text, grid, borders or other objects. These four poses must clearly differ in leg/body silhouette, with no human hands.

`tools/build-assets.ts` 从四单元裁取完整 alpha 轮廓，共用缩放比例，制作 dragging/flutter/falling/landing 四组 PNG 图集和版本化 JSON。全部为 480 × 480 的 2x 帧，脚底锚点 (240,480)，alpha 命中阈值 128，与最终 PNG 同批计算。耳朵、尾巴和爪子完整可见，最低轮廓对齐帧底。悬空时该锚点是下落最终使用的虚拟脚底，无独立脚底抖动位移。

按单元编号 0=蜷身、1/2=两种扑腾、3=落地蹲伏：抓住循环 `[0,0,0,0,1,2,1,0]` 每帧 200ms；松手扑腾 `[1,2,1,2]` 每帧 90ms；下落 `[0,1]` 每帧 140ms 循环；落地 `[3,3,idle]` 每帧 140ms，最终回到精确待机像素。它们是可调初值，不是规格固定时长。渲染按实际经过时间选帧，主进程位置公式独立于素材。

已查看源图和整应用 held/flutter/landing 截图，三个姿态可辨、全身无跨格裁切。生成姿态仍可能有脸型、比例和朝向细节差异，动画的自然度与长期观看效果需要真实桌面动态验收。
