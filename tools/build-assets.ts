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

// One row defines each action's source, pose/timing sequence and playback mode.
// Pose -1 uses the exact idle pixels for a seamless return to rest.
const actionConfigs = [
  {
    action: "walking",
    source: "walk",
    loop: "repeat",
    sequence: [
      [0, 150],
      [1, 150],
      [2, 150],
      [3, 150],
    ],
  },
  {
    action: "stretching",
    source: "stretch",
    loop: "once",
    sequence: [
      [-1, 180],
      [0, 180],
      [1, 240],
      [2, 700],
      [3, 240],
      [0, 180],
      [-1, 180],
    ],
  },
  {
    action: "playing",
    source: "play",
    loop: "once",
    sequence: [
      [-1, 160],
      [0, 180],
      [1, 180],
      [2, 240],
      [3, 300],
      [2, 180],
      [1, 180],
      [0, 180],
      [-1, 160],
    ],
  },
  {
    action: "tilt",
    source: "tilt",
    loop: "once",
    sequence: [
      [-1, 140],
      [0, 140],
      [1, 140],
      [2, 140],
      [2, 350],
      [3, 140],
      [1, 140],
      [0, 140],
      [-1, 140],
    ],
  },
  {
    action: "paw",
    source: "paw",
    loop: "once",
    sequence: [
      [-1, 140],
      [0, 140],
      [1, 140],
      [2, 140],
      [2, 350],
      [3, 140],
      [1, 140],
      [0, 140],
      [-1, 140],
    ],
  },
  {
    action: "belly",
    source: "belly",
    loop: "once",
    sequence: [
      [-1, 140],
      [0, 140],
      [1, 140],
      [2, 140],
      [3, 140],
      [3, 350],
      [2, 140],
      [1, 140],
      [0, 140],
      [-1, 140],
    ],
  },
  {
    action: "dragging",
    source: "return",
    loop: "repeat",
    sequence: [
      [0, 200],
      [0, 200],
      [0, 200],
      [0, 200],
      [1, 200],
      [2, 200],
      [1, 200],
      [0, 200],
    ],
  },
  {
    action: "flutter",
    source: "return",
    loop: "once",
    sequence: [
      [1, 90],
      [2, 90],
      [1, 90],
      [2, 90],
    ],
  },
  {
    action: "falling",
    source: "return",
    loop: "repeat",
    sequence: [
      [0, 140],
      [1, 140],
    ],
  },
  {
    action: "landing",
    source: "return",
    loop: "once",
    sequence: [
      [3, 140],
      [3, 140],
      [-1, 140],
    ],
  },
] as const;

// Generated response sheets are 2x2. Normalize each cell to one 2x canvas,
// preserving its complete silhouette and anchoring the lowest opaque pixel.
for (const { action, source, sequence, loop } of actionConfigs) {
  const input = `src/assets/corgi-${source}.png`;
  const size = await sharp(input).metadata();
  const cellWidth = Math.floor(size.width! / 2);
  const cellHeight = Math.floor(size.height! / 2);
  const poses: Buffer[] = [];
  for (let index = 0; index < 4; index++) {
    const cell = await sharp(input)
      .extract({
        left: (index % 2) * cellWidth,
        top: Math.floor(index / 2) * cellHeight,
        width: cellWidth,
        height: cellHeight,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let left = cellWidth,
      top = cellHeight,
      right = 0,
      bottom = 0;
    for (let y = 0; y < cellHeight; y++)
      for (let x = 0; x < cellWidth; x++) {
        const offset = (y * cellWidth + x) * 4 + 3;
        if (cell.data[offset]! < 128) cell.data[offset] = 0;
        else {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    if (right <= left || bottom <= top)
      throw new Error(`Empty ${action} cell ${index}`);
    poses.push(
      await sharp(cell.data, { raw: cell.info })
        .extract({
          left,
          top,
          width: right - left + 1,
          height: bottom - top + 1,
        })
        .png()
        .toBuffer(),
    );
  }
  // Shared scale across an action avoids size pumping between its poses.
  const dimensions = await Promise.all(
    poses.map((pose) => sharp(pose).metadata()),
  );
  const ratio = Math.min(
    420 / Math.max(...dimensions.map((d) => d.width!)),
    402 / Math.max(...dimensions.map((d) => d.height!)),
  );
  const responseFrames = [];
  const responseLayers = [];
  for (const [index, [pose, durationMs]] of sequence.entries()) {
    let raster: Buffer;
    if (pose === -1)
      raster = await sharp("src/assets/generated/idle-atlas.png")
        .extract({ left: 0, top: 0, width: 480, height: 480 })
        .png()
        .toBuffer();
    else {
      const width = Math.round(dimensions[pose]!.width! * ratio);
      const height = Math.round(dimensions[pose]!.height! * ratio);
      const image = await sharp(poses[pose])
        .resize(width, height)
        .png()
        .toBuffer();
      raster = await sharp({
        create: {
          width: 480,
          height: 480,
          channels: 4,
          background: "#00000000",
        },
      })
        .composite([
          {
            input: image,
            left: Math.round((480 - width) / 2),
            top: 480 - height,
          },
        ])
        .png()
        .toBuffer();
    }
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
    responseFrames.push({
      region: { x: index * 480, y: 0, width: 480, height: 480 },
      durationMs,
      foot: { x: 240, y: 480 },
      hitRows,
    });
    responseLayers.push({ input: raster, left: index * 480, top: 0 });
  }
  const response = atlasSchema.parse({
    version: 1,
    action,
    image: `${action}-atlas.png`,
    width: sequence.length * 480,
    height: 480,
    pixelRatio: 2,
    loop,
    hitAlphaThreshold: 128,
    frames: responseFrames,
  });
  await sharp({
    create: {
      width: response.width,
      height: 480,
      channels: 4,
      background: "#00000000",
    },
  })
    .composite(responseLayers)
    .png()
    .toFile(`src/assets/generated/${action}-atlas.png`);
  await writeFile(
    `src/assets/generated/${action}-atlas.json`,
    JSON.stringify(response) + "\n",
  );
}
