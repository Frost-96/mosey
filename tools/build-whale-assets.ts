import { createHitRows } from "./asset-hit-rows.ts";
import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { atlasSchema } from "../src/shared/assets.ts";

const integer = z.number().int().nonnegative();
const configuration = z.record(
  z.enum(["resting", "walking"]),
  z.strictObject({
    source: z.string().regex(/^source\/[a-z0-9-]+\.png$/),
    scale: z.number().positive(),
    loop: z.literal("repeat"),
    frames: z
      .array(
        z.strictObject({
          region: z.strictObject({
            x: integer,
            y: integer,
            width: integer.positive(),
            height: integer.positive(),
          }),
          foot: z.strictObject({ x: integer, y: integer }),
          durationMs: integer.positive(),
        }),
      )
      .min(1),
  }),
);
const directory = "src/assets/characters/whale";
const actions = configuration.parse(
  JSON.parse(await readFile(`${directory}/processing.json`, "utf8")),
);
await mkdir("src/assets/generated/whale", { recursive: true });
for (const [action, config] of Object.entries(actions)) {
  const frames = [];
  const layers = [];
  for (const [index, input] of config.frames.entries()) {
    const region = input.region;
    const cell = await sharp(`${directory}/${config.source}`)
      .extract({
        left: region.x,
        top: region.y,
        width: region.width,
        height: region.height,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let left = region.width,
      top = region.height,
      right = -1,
      bottom = -1;
    for (let y = 0; y < region.height; y++)
      for (let x = 0; x < region.width; x++) {
        const offset = (y * region.width + x) * 4 + 3;
        if (cell.data[offset]! < 128) cell.data[offset] = 0;
        else {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    if (right < left || bottom < top)
      throw new Error(`Empty whale ${action} frame ${index}`);
    const width = Math.round((right - left + 1) * config.scale);
    const height = Math.round((bottom - top + 1) * config.scale);
    const targetLeft = Math.round(240 + (left - input.foot.x) * config.scale);
    const targetTop = Math.round(480 + (top - input.foot.y) * config.scale);
    if (
      targetLeft < 0 ||
      targetTop < 0 ||
      targetLeft + width > 480 ||
      targetTop + height > 480
    )
      throw new Error(`Clipped whale ${action} frame ${index}`);
    const image = await sharp(cell.data, { raw: cell.info })
      .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
      .resize(width, height)
      .png()
      .toBuffer();
    const raster = await sharp({
      create: { width: 480, height: 480, channels: 4, background: "#00000000" },
    })
      .composite([{ input: image, left: targetLeft, top: targetTop }])
      .png()
      .toBuffer();
    const pixels = await sharp(raster).raw().toBuffer();
    const hitRows = createHitRows(pixels, 480, 480);
    frames.push({
      region: { x: index * 480, y: 0, width: 480, height: 480 },
      durationMs: input.durationMs,
      foot: { x: 240, y: 480 },
      hitRows,
    });
    layers.push({ input: raster, left: index * 480, top: 0 });
  }
  const image = `${action === "resting" ? "idle" : action}-atlas.png`;
  const atlas = atlasSchema.parse({
    version: 1,
    action,
    image,
    width: frames.length * 480,
    height: 480,
    pixelRatio: 2,
    loop: config.loop,
    hitAlphaThreshold: 128,
    frames,
  });
  await sharp({
    create: {
      width: atlas.width,
      height: atlas.height,
      channels: 4,
      background: "#00000000",
    },
  })
    .composite(layers)
    .png()
    .toFile(`src/assets/generated/whale/${image}`);
  await writeFile(
    `src/assets/generated/whale/${image.replace(".png", ".json")}`,
    JSON.stringify(atlas) + "\n",
  );
}
