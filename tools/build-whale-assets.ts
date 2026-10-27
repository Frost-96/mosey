import { createHitRows } from "./asset-hit-rows.ts";
import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { atlasSchema } from "../src/shared/assets.ts";

const integer = z.number().int().nonnegative();
const configuration = z.record(
  atlasSchema.shape.action,
  z.strictObject({
    source: z.string().regex(/^source\/[a-z0-9-]+\.png$/),
    scale: z.number().positive(),
    loop: z.enum(["repeat", "once"]),
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
          source: z
            .string()
            .regex(/^source\/[a-z0-9-]+\.png$/)
            .optional(),
          scale: z.number().positive().optional(),
          readableRegions: z
            .array(
              z.strictObject({
                x: integer,
                y: integer,
                width: integer.positive(),
                height: integer.positive(),
              }),
            )
            .optional(),
          bubbles: z
            .strictObject({
              regions: z
                .array(
                  z.strictObject({
                    x: integer,
                    y: integer,
                    width: integer.positive(),
                    height: integer.positive(),
                  }),
                )
                .min(1),
              rise: integer,
              opacity: z.number().min(0).max(1),
            })
            .optional(),
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
const sourceScales = new Map<string, number>();
for (const [action, config] of Object.entries(actions)) {
  const frames = [];
  const layers = [];
  const leftLayers = [];
  const hasLettering = config.frames.some(
    (frame) => frame.readableRegions?.length,
  );
  for (const [index, input] of config.frames.entries()) {
    const region = input.region;
    const source = input.source ?? config.source;
    const scale = input.scale ?? config.scale;
    const previousScale = sourceScales.get(source);
    if (previousScale !== undefined && previousScale !== scale)
      throw new Error(`Inconsistent fixed source scale for ${source}`);
    sourceScales.set(source, scale);
    const cell = await sharp(`${directory}/${source}`)
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
    const width = Math.round((right - left + 1) * scale);
    const height = Math.round((bottom - top + 1) * scale);
    const targetLeft = Math.round(240 + (left - input.foot.x) * scale);
    const targetTop = Math.round(480 + (top - input.foot.y) * scale);
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
    let raster = await sharp({
      create: { width: 480, height: 480, channels: 4, background: "#00000000" },
    })
      .composite([{ input: image, left: targetLeft, top: targetTop }])
      .png()
      .toBuffer();
    const pixels = await sharp(raster).raw().toBuffer();
    const bubbleRise = Math.round((input.bubbles?.rise ?? 0) * scale);
    if (input.bubbles) {
      const original = Buffer.from(pixels);
      for (const area of input.bubbles.regions) {
        const x0 = targetLeft + Math.round((area.x - left) * scale);
        const y0 = targetTop + Math.round((area.y - top) * scale);
        const w = Math.round(area.width * scale);
        const h = Math.round(area.height * scale);
        if (x0 < 0 || y0 - bubbleRise < 0 || x0 + w > 480 || y0 + h > 480)
          throw new Error(`Clipped bubbles in whale ${action} frame ${index}`);
        for (let y = y0; y < y0 + h; y++)
          for (let x = x0; x < x0 + w; x++)
            pixels.fill(0, (y * 480 + x) * 4, (y * 480 + x) * 4 + 4);
        for (let y = y0; y < y0 + h; y++)
          for (let x = x0; x < x0 + w; x++) {
            const from = (y * 480 + x) * 4;
            const to = ((y - bubbleRise) * 480 + x) * 4;
            original.copy(pixels, to, from, from + 4);
            pixels[to + 3] = Math.round(
              original[from + 3]! * input.bubbles.opacity,
            );
          }
      }
      raster = await sharp(pixels, {
        raw: { width: 480, height: 480, channels: 4 },
      })
        .png()
        .toBuffer();
    }
    if (hasLettering) {
      const readable = Buffer.from(pixels);
      for (const area of input.readableRegions ?? []) {
        if (
          area.x + area.width > region.width ||
          area.y + area.height > region.height
        )
          throw new Error(`Lettering outside whale ${action} frame ${index}`);
        const x0 = targetLeft + Math.round((area.x - left) * scale);
        const y0 = targetTop + Math.round((area.y - top) * scale) - bubbleRise;
        const w = Math.round(area.width * scale);
        const h = Math.round(area.height * scale);
        if (x0 < 0 || y0 < 0 || x0 + w > 480 || y0 + h > 480)
          throw new Error(
            `Clipped lettering in whale ${action} frame ${index}`,
          );
        // Reverse RGB inside the opaque bubble only; preserve every alpha byte.
        // The complete frame is then mirrored, leaving its lettering readable.
        for (let y = y0; y < y0 + h; y++)
          for (let x = 0; x < w; x++)
            for (let channel = 0; channel < 3; channel++)
              readable[(y * 480 + x0 + x) * 4 + channel] =
                pixels[(y * 480 + x0 + w - 1 - x) * 4 + channel]!;
      }
      const mirrored = await sharp(readable, {
        raw: { width: 480, height: 480, channels: 4 },
      })
        .flop()
        .png()
        .toBuffer();
      leftLayers.push({ input: mirrored, left: index * 480, top: 0 });
    }
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
    ...(hasLettering ? { leftImage: image.replace(".png", "-left.png") } : {}),
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
  if (atlas.leftImage)
    await sharp({
      create: {
        width: atlas.width,
        height: atlas.height,
        channels: 4,
        background: "#00000000",
      },
    })
      .composite(leftLayers)
      .png()
      .toFile(`src/assets/generated/whale/${atlas.leftImage}`);
  await writeFile(
    `src/assets/generated/whale/${image.replace(".png", ".json")}`,
    JSON.stringify(atlas) + "\n",
  );
}
