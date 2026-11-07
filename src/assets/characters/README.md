# 内置角色素材

Claude、Gemini、GPT 和 DeepSeek 使用各角色目录中的 `sprites/` 与 `processing.json` 构建。`pnpm assets:build` 输出 PNG 图集与同源透明命中数据到 `src/assets/generated/`；构建不依赖预览服务或 `test-results/`。

`adoption.json` 保存采用的图集哈希、动作来源和完整生成请求，实际原图与参考图保存在 `provenance/images/`，原图分帧和对齐记录保存在 `provenance/processing-history.json`。`motion.json` 描述行走的步幅与逐帧位移。DeepSeek 保留 `whale` 标识，以兼容已有角色选择。

柯基继续使用 `src/assets/corgi-*.png` 和既有构建流程。角色形象的来源归属沿用各目录的生成记录，不表示模型厂商的官方角色。
