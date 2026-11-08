import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const size = 480,
  foot = { x: 240, y: 462 };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function bounds(pixels, width, region) {
  let left = Infinity,
    top = Infinity,
    right = -1,
    bottom = -1;
  for (let y = region.y; y < region.y + region.height; y++)
    for (let x = region.x; x < region.x + region.width; x++)
      if (pixels[(y * width + x) * 4 + 3] >= 128) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  if (right < left) throw new Error("Empty pose");
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
const full = { x: 0, y: 0, width: size, height: size };
const originals = {};
for (const [key, file] of [
  ["idle", "references/standing.png"],
  ["seat", "references/seated.png"],
]) {
  originals[key] = {
    pixels: await sharp(`${dir}/${file}`).ensureAlpha().raw().toBuffer(),
    source: { file },
  };
}
const oldHabitDir = new URL("../expressive-daily-v1/", import.meta.url);
const oldHabit = JSON.parse(
  await readFile(new URL("manifest.json", oldHabitDir), "utf8"),
).actions.habit;
for (const index of [12, 13, 14]) {
  const f = oldHabit.frames.find((f) => f.sourceFrameIndex === index),
    r = f.region;
  originals[`book${index}`] = {
    pixels: await sharp(await readFile(new URL(oldHabit.image, oldHabitDir)))
      .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
      .ensureAlpha()
      .raw()
      .toBuffer(),
    source: {
      file: `../expressive-daily-v1/${oldHabit.image}`,
      region: r,
      sourceFrameIndex: index,
    },
  };
}
const sourceConfigs = [
  {
    name: "arms",
    columns: 4,
    rows: 2,
    reference: "idle",
    basis: "height",
    basisIndex: 0,
  },
  {
    name: "sitting",
    columns: 4,
    rows: 2,
    reference: "idle",
    basis: "width",
    basisIndex: 3,
  },
  {
    name: "sitting-loop",
    columns: 2,
    rows: 2,
    reference: "seat",
    basis: "height",
    basisIndex: 0,
  },
  {
    name: "book",
    columns: 2,
    rows: 2,
    reference: "idle",
    basis: "height",
    basisIndex: 0,
  },
];
const authored = {},
  records = [];
for (const config of sourceConfigs) {
  const file = `${config.name}-source.png`,
    bytes = await readFile(`${dir}/${file}`);
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) data[i] = 0;
  const cells = Array.from({ length: config.rows * config.columns }, (_, i) => {
    const col = i % config.columns,
      row = Math.floor(i / config.columns),
      x = Math.round((col * info.width) / config.columns),
      y = Math.round((row * info.height) / config.rows);
    return {
      x,
      y,
      width: Math.round(((col + 1) * info.width) / config.columns) - x,
      height: Math.round(((row + 1) * info.height) / config.rows) - y,
    };
  });
  const b = cells.map((c) => bounds(data, info.width, c)),
    reference = bounds(originals[config.reference].pixels, size, full);
  const scale = reference[config.basis] / b[config.basisIndex][config.basis];
  const frameRecords = [];
  for (const [i, r] of b.entries()) {
    const width = Math.round(r.width * scale),
      height = Math.round(r.height * scale),
      left = Math.round(
        foot.x + (r.x - cells[i].x - cells[i].width / 2) * scale,
      ),
      top = foot.y - height;
    if (left < 0 || top < 0 || left + width > size || top + height > size)
      throw new Error(`Clipped ${config.name}/${i}`);
    const tile = await sharp(data, { raw: info })
      .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
      .resize(width, height, { fit: "fill" })
      .raw()
      .toBuffer();
    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < height; y++)
      tile.copy(
        pixels,
        ((y + top) * size + left) * 4,
        y * width * 4,
        (y + 1) * width * 4,
      );
    const source = {
      file,
      index: i,
      sourceRegion: r,
      sourceCell: cells[i],
      uniformScale: scale,
      placement: { x: left, y: top, width, height },
    };
    authored[`${config.name}:${i}`] = { pixels, source };
    frameRecords.push(source);
  }
  const inputReferences = {
    arms: ["standing.png"],
    sitting: ["standing.png", "seated.png"],
    "sitting-loop": ["seated.png"],
    book: ["standing.png", "open-book.png"],
  }[config.name];
  records.push({
    file,
    sha256: sha(bytes),
    width: info.width,
    height: info.height,
    grid: { columns: config.columns, rows: config.rows },
    promptFile: `${config.name}-prompt.txt`,
    inputReferences: inputReferences.map((file) => `references/${file}`),
    basis: {
      reference: config.reference,
      dimension: config.basis,
      sourceFrameIndex: config.basisIndex,
    },
    uniformScale: scale,
    frames: frameRecords,
  });
}
const O = (key, durationMs) => ({ ...originals[key], durationMs });
const N = (key, durationMs) => ({ ...authored[key], durationMs });
const specifications = [
  {
    family: "runtime",
    action: "paw",
    loop: "once",
    notes:
      "Keep book held on viewer-left; only viewer-right hand rises/waves. Removes alternating hands and extra-arm/floating-book poses.",
    sequence: [
      O("idle", 160),
      N("arms:1", 120),
      N("arms:2", 160),
      N("arms:3", 220),
      N("arms:2", 140),
      N("arms:1", 120),
      O("idle", 180),
    ],
  },
  {
    family: "runtime",
    action: "stretching",
    loop: "once",
    notes:
      "One free viewer-right arm stretches; viewer-left book-holding arm stays fixed, with a connected shoulder and neck.",
    sequence: [
      O("idle", 180),
      N("arms:5", 150),
      N("arms:6", 180),
      N("arms:7", 550),
      N("arms:6", 180),
      N("arms:5", 150),
      O("idle", 180),
    ],
  },
  {
    family: "gentle",
    action: "sittingdown",
    loop: "once",
    notes:
      "Monotonic lowering, one uniform scale. Generated poses0–2 had elongated standing legs and are excluded; use coherent poses3–7 between exact existing standing/seated endpoints.",
    sequence: [
      O("idle", 180),
      N("sitting:3", 120),
      N("sitting:4", 120),
      N("sitting:5", 140),
      N("sitting:6", 140),
      N("sitting:7", 140),
      O("seat", 200),
    ],
  },
  {
    family: "gentle",
    action: "standingup",
    loop: "once",
    notes:
      "Reverse the same coherent sit-down poses, preserving head size and increasing height monotonically.",
    sequence: [
      O("seat", 180),
      N("sitting:7", 120),
      N("sitting:6", 120),
      N("sitting:5", 140),
      N("sitting:4", 140),
      N("sitting:3", 140),
      O("idle", 200),
    ],
  },
  {
    family: "gentle",
    action: "sitting",
    loop: "repeat",
    notes:
      "Stable seated body and ground contact; eye/head glance and free hand move without whole-body scale pulsing.",
    sequence: [
      O("seat", 850),
      N("sitting-loop:1", 380),
      O("seat", 250),
      N("sitting-loop:2", 150),
      N("sitting-loop:3", 450),
      N("sitting-loop:2", 150),
      O("seat", 500),
    ],
  },
  {
    family: "expressive",
    action: "habit",
    loop: "once",
    notes:
      "Add genuine partially opened covers around the original reading/page-turn poses; retain one book, progressively separate wrists, reverse for closing.",
    sequence: [
      O("idle", 140),
      O("book12", 160),
      N("book:1", 120),
      N("book:2", 140),
      O("book13", 1600),
      O("book14", 400),
      O("book13", 240),
      N("book:2", 140),
      N("book:1", 120),
      O("book12", 140),
      O("idle", 220),
    ],
  },
];
await mkdir(`${dir}/sprites`, { recursive: true });
const actions = [];
for (const spec of specifications) {
  const width = size * spec.sequence.length,
    pixels = Buffer.alloc(width * size * 4);
  for (const [i, f] of spec.sequence.entries())
    for (let y = 0; y < size; y++)
      f.pixels.copy(
        pixels,
        (y * width + i * size) * 4,
        y * size * 4,
        (y + 1) * size * 4,
      );
  const image = `sprites/${spec.family}-${spec.action}.webp`,
    bytes = await sharp(pixels, { raw: { width, height: size, channels: 4 } })
      .webp({ lossless: true })
      .toBuffer();
  await writeFile(`${dir}/${image}`, bytes);
  actions.push({
    family: spec.family,
    action: spec.action,
    image,
    sha256: sha(bytes),
    width,
    height: size,
    loop: spec.loop,
    notes: spec.notes,
    frames: spec.sequence.map((f, i) => ({
      region: { x: i * size, y: 0, width: size, height: size },
      foot,
      durationMs: f.durationMs,
      source: f.source,
    })),
  });
}
await writeFile(
  `${dir}/replacements.json`,
  JSON.stringify(
    {
      version: 1,
      character: "claude",
      tool: "built-in image_gen",
      record: "generation-record.json",
      actions,
    },
    null,
    2,
  ) + "\n",
);
const references = [];
for (const f of [
  "standing.png",
  "seated.png",
  "open-book.png",
  "paw-wrong-side.png",
  "stretch-extra-arm.png",
])
  references.push({
    file: `references/${f}`,
    sha256: sha(await readFile(`${dir}/references/${f}`)),
  });
const originalIndexBytes = await readFile(`${dir}/originals/index.json`);
await writeFile(
  `${dir}/generation-record.json`,
  JSON.stringify(
    {
      version: 1,
      character: "claude",
      createdOn: "2026-11-08",
      tool: "built-in image_gen",
      transparentBackground: true,
      mode: "identity-preserve",
      references,
      requests: records,
      originals: {
        file: "originals/index.json",
        sha256: sha(originalIndexBytes),
      },
      processing: {
        script: "prepare.mjs",
        frameSize: size,
        foot,
        alphaThreshold: 128,
        rule: "One scale per generated sheet, no per-frame scaling. Only crop, transparent cleanup, resize, baseline placement and raw RGBA atlas assembly.",
      },
      excluded: {
        sitting: [
          {
            indices: [0, 1, 2],
            reason:
              "Generated standing legs are elongated relative to approved identity; use poses3–7 with a single reference-width scale for monotonic lowering.",
          },
        ],
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(
  actions.map((a) => ({
    family: a.family,
    action: a.action,
    frames: a.frames.length,
    heights: a.frames.map((f) => f.source.placement?.height ?? null),
  })),
);
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import console from "node:console";
