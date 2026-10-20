import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { atlasSchema } from "../src/shared/assets.ts";

// Use only the first sample pose: the other sample poses change facial/body details.
// Remove low-alpha generation fringe, crop the known solid identity, then resize at 2x.
const source = await sharp("src/assets/corgi-idle.png")
  .extract({ left: 56, top: 56, width: 539, height: 506 })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
for (let i = 3; i < source.data.length; i += 4)
  if (source.data[i]! < 128) source.data[i] = 0;
const frames = [];
const layers = [];
for (const [index, height] of [394, 398, 402, 398].entries()) {
  const image = await sharp(source.data, { raw: source.info })
    .resize(420, height)
    .png()
    .toBuffer();
  const raster = await sharp({
    create: { width: 480, height: 480, channels: 4, background: "#00000000" },
  })
    .composite([{ input: image, left: 30, top: 480 - height }])
    .png()
    .toBuffer();
  const pixels = await sharp(raster).raw().toBuffer();
  const hitRows: [number, number][][] = [];
  for (let y = 0; y < 480; y++) {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= 480; x++) {
      const opaque = x < 480 && pixels[(y * 480 + x) * 4 + 3]! >= 128;
      if (opaque && start < 0) start = x;
      if (!opaque && start >= 0) {
        runs.push([start, x]);
        start = -1;
      }
    }
    hitRows.push(runs);
  }
  frames.push({
    region: { x: index * 480, y: 0, width: 480, height: 480 },
    durationMs: 500,
    foot: { x: 240, y: 480 },
    hitRows,
  });
  layers.push({ input: raster, left: index * 480, top: 0 });
}
const atlas = atlasSchema.parse({
  version: 1,
  action: "resting",
  image: "idle-atlas.png",
  width: 1920,
  height: 480,
  pixelRatio: 2,
  loop: "repeat",
  hitAlphaThreshold: 128,
  frames,
});
await mkdir("src/assets/generated", { recursive: true });
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
  .toFile("src/assets/generated/idle-atlas.png");
await writeFile(
  "src/assets/generated/idle-atlas.json",
  JSON.stringify(atlas) + "\n",
);
