import { writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import console from "node:console";
import { createHash } from "node:crypto";
import sharp from "sharp";
const dir = new URL(".", import.meta.url);
const frames = [
  {
    file: "generated-front-left.png",
    cell: 0,
    from: 0,
    to: 1,
    t: 0.5,
    description: "视线先向左，头部小幅跟随，保持在原左转端点之前。",
  },
  {
    file: "generated-left-front.png",
    cell: 0,
    from: 1,
    to: 0,
    t: 1 / 3,
    description: "视线先回中央，头仍轻微朝左。",
  },
  {
    file: "generated-left-front.png",
    cell: 1,
    from: 1,
    to: 0,
    t: 2 / 3,
    description: "头进一步回正，仍保留极轻左向。",
  },
  {
    file: "generated-front-right-corrected.png",
    cell: 0,
    from: 0,
    to: 2,
    t: 1 / 3,
    description: "视线先右移，面部只微微向右。",
  },
  {
    file: "generated-front-right-corrected.png",
    cell: 1,
    from: 0,
    to: 2,
    t: 2 / 3,
    description: "头部继续向右跟随，幅度小于原右转端点。",
  },
  {
    file: "generated-right-front.png",
    cell: 1,
    from: 2,
    to: 3,
    t: 0.5,
    description: "视线回中央，头从右向正面恢复。",
  },
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const atlas = Buffer.alloc(480 * frames.length * 480 * 4),
  rasters = [];
for (const [index, f] of frames.entries()) {
  const { data, info } = await sharp(new URL(f.file, dir).pathname)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 1774 || info.height !== 887)
    throw Error("Unexpected source dimensions");
  for (let n = 3; n < data.length; n += 4) if (data[n] < 128) data[n] = 0;
  const resized = await sharp(data, { raw: info })
    .extract({ left: f.cell * 887, top: 0, width: 887, height: 887 })
    .resize(475, 475)
    .ensureAlpha()
    .raw()
    .toBuffer();
  const pixels = Buffer.alloc(480 * 480 * 4);
  for (let row = 0; row < 475; row++)
    resized.copy(
      pixels,
      ((row + 3) * 480 + 3) * 4,
      row * 475 * 4,
      (row + 1) * 475 * 4,
    );
  let count = 0;
  for (let y = 0; y < 480; y++)
    for (let x = 0; x < 480; x++)
      if (pixels[(y * 480 + x) * 4 + 3] >= 128) {
        count++;
        if (x === 0 || x === 479 || y === 0 || y >= 462)
          throw Error("Frame exceeds support/margin " + index);
      }
  if (!count) throw Error("Empty frame");
  for (let y = 0; y < 480; y++)
    pixels.copy(
      atlas,
      (y * 480 * frames.length + index * 480) * 4,
      y * 480 * 4,
      (y + 1) * 480 * 4,
    );
  const png = await sharp(pixels, {
    raw: { width: 480, height: 480, channels: 4 },
  })
    .png()
    .toBuffer();
  rasters.push(png);
  await writeFile(new URL(`midpoint-${index}.png`, dir), png);
  f.index = index;
  f.region = { x: index * 480, y: 0, width: 480, height: 480 };
  f.foot = { x: 240, y: 462 };
  f.sourceRegion = { x: f.cell * 887, y: 0, width: 887, height: 887 };
}
const webp = await sharp(atlas, {
  raw: { width: frames.length * 480, height: 480, channels: 4 },
})
  .webp({ lossless: true })
  .toBuffer();
await writeFile(new URL("midpoints.webp", dir), webp);
const meta = {
  version: 1,
  character: "gemini",
  action: "looking",
  image: "midpoints.webp",
  sha256: hash(webp),
  width: 2880,
  height: 480,
  frames,
  processing: {
    script: "prepare.mjs",
    alphaThreshold: 128,
    uniformScale: 475 / 887,
    allFramesSourceCellSize: 887,
    allFramesResizedCellSize: 475,
    allFramesPlacement: { x: 3, y: 3 },
    foot: { x: 240, y: 462 },
    basis:
      "One common scale for all six generated poses; first original frame visible height382 and first generated pose height713. Integer full-cell resize475/887, fixed translation(3,3), no per-frame correction.",
    atlasAssembly: "Direct RGBA row copy; lossless WebP.",
  },
};
await writeFile(
  new URL("midpoints.json", dir),
  JSON.stringify(meta, null, 2) + "\n",
);
const rows = [
    ["0 to 1", ["key-0.png", 0, "key-1.png"]],
    ["1 to 0", ["key-1.png", 1, 2, "key-0.png"]],
    ["0 to 2", ["key-0.png", 3, 4, "key-2.png"]],
    ["2 to 3", ["key-2.png", 5, "key-3.png"]],
  ],
  layers = [];
let svg = '<rect width="1040" height="1040" fill="#f3f2ee"/>';
for (const [row, [label, items]] of rows.entries()) {
  svg += `<text x="8" y="${row * 260 + 130}" font-size="20" font-family="Arial">${label}</text>`;
  for (const [column, item] of items.entries()) {
    const x = 110 + column * 230,
      y = row * 260;
    layers.push({
      input: await sharp(
        typeof item === "string" ? new URL(item, dir).pathname : rasters[item],
      )
        .resize(220, 220)
        .png()
        .toBuffer(),
      left: x,
      top: y,
    });
    svg += `<text x="${x + 35}" y="${y + 245}" font-size="16" font-family="Arial">${typeof item === "string" ? item.replace(".png", "") : "new " + item}</text>`;
  }
}
layers.unshift({
  input: Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="1040">${svg}</svg>`,
  ),
  left: 0,
  top: 0,
});
await sharp({
  create: { width: 1040, height: 1040, channels: 4, background: "#f3f2ee" },
})
  .composite(layers)
  .png()
  .toFile(new URL("comparison.png", dir).pathname);
console.log("6 frames normalized with one fixed scale and translation.");
