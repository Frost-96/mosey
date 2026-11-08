import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createHash } from "node:crypto";
const dir = path.dirname(fileURLToPath(import.meta.url)),
  char = path.resolve(dir, "../.."),
  qa = path.resolve(char, "../../../../test-results/motion-coherence/gemini");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const p = JSON.parse(await fs.readFile(char + "/processing.json", "utf8")),
  g = JSON.parse(
    await fs.readFile(
      char + "/extensions/gentle-daily-v2/manifest.json",
      "utf8",
    ),
  );
await fs.mkdir(dir + "/sprites", { recursive: true });
await fs.mkdir(dir + "/originals/runtime", { recursive: true });
await fs.mkdir(dir + "/originals/gentle", { recursive: true });
await fs.mkdir(qa, { recursive: true });
for (const [family, action, config, base] of [
  ["runtime", "falling", p.falling, char],
  ["runtime", "landing", p.landing, char],
  ...["sittingdown", "sitting", "standingup"].map((a) => [
    "gentle",
    a,
    g.actions[a],
    char + "/extensions/gentle-daily-v2",
  ]),
]) {
  const target = dir + `/originals/${family}/${action}.webp`;
  try {
    await fs.access(target);
  } catch {
    await fs.copyFile(base + "/" + config.image, target);
    await fs.writeFile(
      target.replace(".webp", ".json"),
      JSON.stringify(config, null, 2) + "\n",
    );
  }
}
function bounds(data, width, cell) {
  let l = cell.x + cell.width,
    t = cell.y + cell.height,
    r = -1,
    b = -1;
  for (let y = cell.y; y < cell.y + cell.height; y++)
    for (let x = cell.x; x < cell.x + cell.width; x++)
      if (data[(y * width + x) * 4 + 3] >= 128) {
        l = Math.min(l, x);
        t = Math.min(t, y);
        r = Math.max(r, x);
        b = Math.max(b, y);
      }
  if (r < l) throw Error("Empty");
  return { x: l, y: t, width: r - l + 1, height: b - t + 1 };
}
async function prepare(file, columns, rows, targetHeight) {
  const { data, info } = await sharp(dir + "/" + file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) data[i] = 0;
  const cells = Array.from({ length: columns * rows }, (_, i) => {
      const c = i % columns,
        r = Math.floor(i / columns),
        x = Math.round((c * info.width) / columns),
        y = Math.round((r * info.height) / rows);
      return {
        x,
        y,
        width: Math.round(((c + 1) * info.width) / columns) - x,
        height: Math.round(((r + 1) * info.height) / rows) - y,
      };
    }),
    boxes = cells.map((c) => bounds(data, info.width, c)),
    scale = targetHeight / boxes[0].height,
    frames = [];
  for (const [index, b] of boxes.entries()) {
    const cell = cells[index],
      width = Math.round(b.width * scale),
      height = Math.round(b.height * scale),
      left = Math.round(240 + (b.x - cell.x - cell.width / 2) * scale),
      top = 462 - height;
    if (left < 0 || top < 0 || left + width > 480)
      throw Error("Clipped " + file + "/" + index);
    const pixels = await sharp(data, { raw: info })
        .extract({ left: b.x, top: b.y, width: b.width, height: b.height })
        .resize(width, height, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer(),
      out = Buffer.alloc(480 * 480 * 4);
    for (let y = 0; y < height; y++)
      pixels.copy(
        out,
        ((y + top) * 480 + left) * 4,
        y * width * 4,
        (y + 1) * width * 4,
      );
    frames.push({
      pixels: out,
      source: {
        file,
        index,
        cell,
        region: b,
        scale,
        placement: { x: left, y: top, width, height },
      },
    });
  }
  return { frames, scale, sourceWidth: info.width, sourceHeight: info.height };
}
const restingFrame = p.resting.frames[0],
  r = restingFrame.region,
  resting = await sharp(char + "/" + p.resting.image)
    .extract({ left: r.x, top: r.y, width: 480, height: 480 })
    .ensureAlpha()
    .raw()
    .toBuffer(),
  restingBounds = bounds(resting, 480, { x: 0, y: 0, width: 480, height: 480 });
const seated = await prepare(
    "seated-corrected-source.png",
    4,
    3,
    restingBounds.height,
  ),
  falling = await prepare("falling-source.png", 2, 2, 393),
  rest = {
    pixels: resting,
    source: {
      file: "../../" + p.resting.image,
      index: 0,
      region: r,
      sha256: hash(await fs.readFile(char + "/" + p.resting.image)),
    },
  };
const configs = [
  {
    family: "gentle",
    action: "sittingdown",
    indices: [-1, 0, 1, 2, 3, 4, 5, 6, 8],
    durations: [100, 60, 80, 90, 100, 100, 110, 110, 140],
    loop: "once",
    prepared: seated,
    notes:
      "A single generation with corrected production head/body proportions; monotonic lowering and one shared scale. Source7 omitted because its crown sat 7px below the seated loop entry.",
  },
  {
    family: "gentle",
    action: "sitting",
    indices: [8, 9, 10, 11, 8],
    durations: [900, 160, 650, 160, 650],
    loop: "repeat",
    prepared: seated,
    notes:
      "All four awake-seated poses from the same corrected sheet; crown varies by at most1px at shared scale, stable hair/head volume.",
  },
  {
    family: "gentle",
    action: "standingup",
    indices: [8, 6, 5, 4, 3, 2, 1, 0, -1],
    durations: [120, 110, 110, 100, 100, 90, 80, 60, 150],
    loop: "once",
    prepared: seated,
    notes:
      "Reverses authored stand-to-sit transition; no per-frame scale; ends with exact original idle pixels.",
  },
  {
    family: "runtime",
    action: "falling",
    indices: [0, 1, 2, 3],
    durations: [100, 100, 100, 100],
    loop: "repeat",
    prepared: falling,
    notes:
      "Small hair/hand loop in the same forward-tilted orientation as former final falling pose, compatible with existing landing entry; removes upright-to-face-down cycle reset.",
  },
];
const actions = [];
for (const c of configs) {
  const width = c.indices.length * 480,
    atlas = Buffer.alloc(width * 480 * 4),
    frames = [];
  for (const [pos, index] of c.indices.entries()) {
    const f = index === -1 ? rest : c.prepared.frames[index];
    for (let y = 0; y < 480; y++)
      f.pixels.copy(
        atlas,
        (y * width + pos * 480) * 4,
        y * 480 * 4,
        (y + 1) * 480 * 4,
      );
    const b = bounds(f.pixels, 480, { x: 0, y: 0, width: 480, height: 480 });
    if (b.y + b.height > 462 || 462 - b.y - b.height > 2)
      throw Error("Support " + c.action + "/" + index);
    frames.push({
      region: { x: pos * 480, y: 0, width: 480, height: 480 },
      foot: { x: 240, y: 462 },
      durationMs: c.durations[pos],
      source: f.source,
      visibleBounds: b,
    });
  }
  const bytes = await sharp(atlas, { raw: { width, height: 480, channels: 4 } })
      .webp({ lossless: true })
      .toBuffer(),
    image = `sprites/${c.action}.webp`;
  await fs.writeFile(dir + "/" + image, bytes);
  actions.push({
    family: c.family,
    action: c.action,
    image,
    sha256: hash(bytes),
    width,
    height: 480,
    loop: c.loop,
    frames,
    notes: c.notes,
    previous: {
      image: `originals/${c.family}/${c.action}.webp`,
      sha256: hash(
        await fs.readFile(dir + `/originals/${c.family}/${c.action}.webp`),
      ),
    },
  });
  const layers = [],
    cols = Math.min(frames.length, 8),
    rows = Math.ceil(frames.length / 8);
  let svg = `<rect width="${cols * 160}" height="${rows * 190 + 35}" fill="#f5f3ee"/><text x="8" y="24" font-size="20" font-family="Arial">revised ${c.action}</text>`;
  for (const [pos, f] of frames.entries()) {
    const x = (pos % 8) * 160,
      y = Math.floor(pos / 8) * 190 + 35;
    layers.push({
      input: await sharp(bytes)
        .extract({ left: f.region.x, top: 0, width: 480, height: 480 })
        .resize(155, 155)
        .png()
        .toBuffer(),
      left: x,
      top: y,
    });
    svg += `<text x="${x + 5}" y="${y + 175}" font-size="13" font-family="Arial">${pos} src${c.indices[pos]} top${f.visibleBounds.y}</text>`;
  }
  layers.unshift({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * 160}" height="${rows * 190 + 35}">${svg}</svg>`,
    ),
    left: 0,
    top: 0,
  });
  await sharp({
    create: {
      width: cols * 160,
      height: rows * 190 + 35,
      channels: 4,
      background: "#f5f3ee",
    },
  })
    .composite(layers)
    .png()
    .toFile(qa + `/revised-${c.action}.png`);
}
await fs.writeFile(
  dir + "/replacements.json",
  JSON.stringify({ version: 1, character: "gemini", actions }, null, 2) + "\n",
);
await fs.writeFile(
  dir + "/processing-record.json",
  JSON.stringify(
    {
      seated: {
        scale: seated.scale,
        sourceWidth: seated.sourceWidth,
        sourceHeight: seated.sourceHeight,
      },
      falling: {
        scale: falling.scale,
        sourceWidth: falling.sourceWidth,
        sourceHeight: falling.sourceHeight,
      },
      method:
        "Alpha below128 cleared; uniform scale per source sheet; fixed column center→240; per-frame bottom contact→462; raw RGBA row copy, lossless WebP.",
      script: "prepare.mjs",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  actions.map((a) => [
    a.action,
    a.frames.length,
    a.frames.map((f) => f.visibleBounds.y),
  ]),
);
import { Buffer } from "node:buffer";
import console from "node:console";
