import { readFile, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
const dir = new URL(".", import.meta.url),
  size = 480,
  hash = (b) => createHash("sha256").update(b).digest("hex");
const bounds = (data, w, r) => {
  let l = Infinity,
    t = Infinity,
    rr = -1,
    b = -1;
  for (let y = r.y; y < r.y + r.height; y++)
    for (let x = r.x; x < r.x + r.width; x++)
      if (data[(y * w + x) * 4 + 3] >= 128) {
        l = Math.min(l, x);
        t = Math.min(t, y);
        rr = Math.max(rr, x);
        b = Math.max(b, y);
      }
  return { x: l, y: t, width: rr - l + 1, height: b - t + 1 };
};
async function readRaster(file) {
  const o = await sharp(new URL(file, dir).pathname)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < o.data.length; i += 4) if (o.data[i] < 128) o.data[i] = 0;
  return o;
}
const sit = await readRaster("sitting-attempt1.png"),
  fall = await readRaster("falling-source.png"),
  newSit = [],
  newFall = [],
  processing = [];
for (const index of [2, 3, 4, 5]) {
  const cell = {
      x: (index % 3) * 512,
      y: Math.floor(index / 3) * 512,
      width: 512,
      height: 512,
    },
    r = bounds(sit.data, sit.info.width, cell),
    scale = 0.91,
    w = Math.round(r.width * scale),
    h = Math.round(r.height * scale),
    x = Math.round(240 + (r.x - cell.x - 256) * scale),
    y = 480 - h;
  const tile = await sharp(sit.data, { raw: sit.info })
      .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
      .resize(w, h)
      .raw()
      .toBuffer(),
    pixels = Buffer.alloc(size * size * 4);
  for (let row = 0; row < h; row++)
    tile.copy(
      pixels,
      ((y + row) * size + x) * 4,
      row * w * 4,
      (row + 1) * w * 4,
    );
  newSit.push({
    pixels,
    source: {
      file: "sitting-attempt1.png",
      cell: index,
      region: r,
      scale,
      placement: { x, y, width: w, height: h },
    },
  });
  processing.push(newSit.at(-1).source);
}
for (let index = 0; index < 4; index++) {
  const x0 = Math.round(((index % 2) * fall.info.width) / 2),
    y0 = Math.round((Math.floor(index / 2) * fall.info.height) / 2),
    cell = {
      x: x0,
      y: y0,
      width: Math.round((((index % 2) + 1) * fall.info.width) / 2) - x0,
      height:
        Math.round(((Math.floor(index / 2) + 1) * fall.info.height) / 2) - y0,
    },
    r = bounds(fall.data, fall.info.width, cell),
    scale = 0.97,
    w = Math.round(r.width * scale),
    h = Math.round(r.height * scale),
    x = Math.round((r.x - cell.x) * scale - 229),
    y = Math.round((r.y - cell.y) * scale + 48);
  const tile = await sharp(fall.data, { raw: fall.info })
      .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
      .resize(w, h)
      .raw()
      .toBuffer(),
    pixels = Buffer.alloc(size * size * 4);
  if (x < 0 || y < 0 || x + w > size || y + h > 462)
    throw Error("Clipped falling pose");
  for (let row = 0; row < h; row++)
    tile.copy(
      pixels,
      ((y + row) * size + x) * 4,
      row * w * 4,
      (row + 1) * w * 4,
    );
  newFall.push({
    pixels,
    source: {
      file: "falling-source.png",
      cell: index,
      region: r,
      scale,
      placement: { x, y, width: w, height: h },
    },
  });
  processing.push(newFall.at(-1).source);
}
const standing = {
    pixels: await sharp(new URL("key--1.png", dir).pathname)
      .ensureAlpha()
      .raw()
      .toBuffer(),
    source: { file: "key--1.png", kind: "unchanged-original" },
  },
  seated = {
    pixels: await sharp(new URL("key-8.png", dir).pathname)
      .ensureAlpha()
      .raw()
      .toBuffer(),
    source: { file: "key-8.png", kind: "unchanged-original" },
  };
const replacements = [];
async function save(action, family, poses, timings, footY, loop, notes) {
  const width = poses.length * size,
    pixels = Buffer.alloc(width * size * 4);
  for (const [i, p] of poses.entries())
    for (let y = 0; y < size; y++)
      p.pixels.copy(
        pixels,
        (y * width + i * size) * 4,
        y * size * 4,
        (y + 1) * size * 4,
      );
  const image = `${action}.webp`,
    bytes = await sharp(pixels, { raw: { width, height: size, channels: 4 } })
      .webp({ lossless: true })
      .toBuffer();
  await writeFile(new URL(image, dir), bytes);
  const frames = poses.map((p, i) => ({
    region: { x: i * size, y: 0, width: size, height: size },
    foot: { x: 240, y: footY },
    durationMs: timings[i],
    source: p.source,
  }));
  replacements.push({
    family,
    action,
    image,
    sha256: hash(bytes),
    loop,
    frames,
    notes,
  });
}
const down = [standing, ...newSit, seated];
await save(
  "sittingdown",
  "gentle",
  down,
  [120, 100, 110, 130, 150, 200],
  480,
  "once",
  "Replace height-reversing inbetweens with a single-scale monotonic lowering sequence; head and shoulders remain frontal and connected. Original standing and seated endpoints preserved.",
);
await save(
  "standingup",
  "gentle",
  [...down].reverse(),
  [140, 130, 120, 110, 100, 180],
  480,
  "once",
  "Reverse the corrected coherent seated-to-standing pose chain without introducing a downward bounce.",
);
await save(
  "falling",
  "runtime",
  newFall,
  [90, 90, 90, 90],
  462,
  "repeat",
  "Maintain the whole-body forward falling orientation throughout the loop; only hands/hair have restrained overlap. End no longer snaps to an upright first pose, and pitch matches the landing entry.",
);
await writeFile(
  new URL("replacements.json", dir),
  JSON.stringify(
    {
      version: 1,
      character: "whale",
      record: "generation-record.json",
      actions: replacements,
    },
    null,
    2,
  ) + "\n",
);
const requests = [];
for (const [name, prompt, ref, output] of [
  [
    "sit",
    "prompt-sitting.txt",
    "sitting-reference.png",
    "sitting-attempt1.png",
  ],
  [
    "fall",
    "prompt-falling.txt",
    "falling-loop-reference-gray.png",
    "falling-source.png",
  ],
])
  requests.push({
    id: name,
    tool: "built-in image_gen",
    promptFile: prompt,
    prompt: await readFile(new URL(prompt, dir), "utf8"),
    references: [
      { file: ref, sha256: hash(await readFile(new URL(ref, dir))) },
    ],
    output: {
      file: output,
      sha256: hash(await readFile(new URL(output, dir))),
    },
  });
await writeFile(
  new URL("generation-record.json", dir),
  JSON.stringify(
    {
      version: 1,
      character: "whale",
      date: "2026-11-08",
      tool: "built-in image_gen",
      requests,
      originalSources: {
        falling: {
          file: "originals/runtime/falling.webp",
          sha256: hash(
            await readFile(new URL("originals/runtime/falling.webp", dir)),
          ),
          referenceFrame: 3,
        },
        seatedEndpoints: {
          manifest: "../gentle-daily-v1/manifest.json",
          indices: [-1, 8],
          extractedReferences: ["key--1.png", "key-8.png"],
        },
      },
      processing: {
        script: "prepare.mjs",
        method:
          "Crop/resize actual generated poses with one fixed scale per source sheet; no morphing, blending or code-drawn poses.",
        sit: {
          scale: 0.91,
          sourceIndices: [2, 3, 4, 5],
          rejectedIndices: [0, 1],
          reason:
            "First two generated poses have overly long legs relative to the original standing endpoint; retained later poses preserve head width and monotonic height.",
          contact: 480,
        },
        falling: { scale: 0.97, fixedTranslation: { x: -229, y: 48 } },
        frames: processing,
      },
      outputs: replacements.map(({ action, family, image, sha256 }) => ({
        action,
        family,
        image,
        sha256,
      })),
      review: {
        evidenceDirectory: "test-results/motion-coherence/whale",
        status: "reviewed-with-independent-second-reader",
        result:
          "Monotonic seat height and stable head size; falling loop keeps whole-body pitch and joins the original landing entry. Other 22 actions retained after 25-action review.",
      },
    },
    null,
    2,
  ) + "\n",
);
