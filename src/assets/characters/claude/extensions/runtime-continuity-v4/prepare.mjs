import fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import console from "node:console";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
const dir = path.dirname(fileURLToPath(import.meta.url));
const id = path.basename(path.resolve(dir, "../.."));
const qa = path.resolve(
  dir,
  "../../../../../../test-results/runtime-continuity-before",
  id,
);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const box = (data, width, c) => {
  let l = c.x + c.width,
    t = c.y + c.height,
    r = -1,
    b = -1;
  for (let y = c.y; y < c.y + c.height; y++)
    for (let x = c.x; x < c.x + c.width; x++)
      if (data[(y * width + x) * 4 + 3] >= 128) {
        l = Math.min(l, x);
        r = Math.max(r, x);
        t = Math.min(t, y);
        b = Math.max(b, y);
      }
  if (r < l) throw Error("Empty");
  return { x: l, y: t, width: r - l + 1, height: b - t + 1 };
};
async function original(action) {
  const file = `originals/${action}.png`,
    bytes = await fs.readFile(dir + "/" + file),
    a = JSON.parse(
      await fs.readFile(dir + `/originals/${action}.json`, "utf8"),
    ),
    frames = [];
  for (const [index, f] of a.frames.entries()) {
    const r = f.region,
      pixels = await sharp(bytes)
        .extract({ left: r.x, top: r.y, width: 480, height: 480 })
        .ensureAlpha()
        .raw()
        .toBuffer();
    frames.push({
      pixels,
      durationMs: f.durationMs,
      foot: f.foot,
      source: { file, sha256: hash(bytes), index, region: r },
    });
  }
  return frames;
}
function translateAirborne(frame, targetBottom, durationMs) {
  const pixels = Buffer.alloc(480 * 480 * 4),
    b = box(frame.pixels, 480, { x: 0, y: 0, width: 480, height: 480 }),
    translateY = targetBottom - b.y - b.height;
  for (let y = 0; y < 480; y++)
    for (let x = 0; x < 480; x++) {
      const offset = (y * 480 + x) * 4;
      if (frame.pixels[offset + 3] < 128) continue;
      if (y + translateY < 0 || y + translateY >= 480)
        throw Error("Clipped airborne pose");
      frame.pixels.copy(
        pixels,
        ((y + translateY) * 480 + x) * 4,
        offset,
        offset + 4,
      );
    }
  return {
    ...frame,
    pixels,
    durationMs,
    source: {
      ...frame.source,
      processing: {
        alphaThreshold: 128,
        scale: 1,
        translate: { x: 0, y: translateY },
        targetBottom,
      },
    },
  };
}
async function generated(file, cols, rows, targetHeight) {
  const bytes = await fs.readFile(dir + "/" + file),
    { data, info } = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4)
    if (data[i + 3] < 128) data.fill(0, i, i + 4);
  const cells = Array.from({ length: cols * rows }, (_, i) => {
      const col = i % cols,
        row = Math.floor(i / cols),
        x = Math.round((col * info.width) / cols),
        y = Math.round((row * info.height) / rows);
      return {
        x,
        y,
        width: Math.round(((col + 1) * info.width) / cols) - x,
        height: Math.round(((row + 1) * info.height) / rows) - y,
      };
    }),
    boxes = cells.map((c) => box(data, info.width, c)),
    scale = targetHeight / boxes[0].height;
  const frames = [];
  for (const [index, b] of boxes.entries()) {
    const c = cells[index],
      width = Math.round(b.width * scale),
      height = Math.round(b.height * scale),
      left = Math.round(240 + (b.x - c.x - c.width / 2) * scale),
      top = 462 - height;
    if (left < 0 || top < 0 || left + width > 480 || top + height > 480)
      throw Error("Clipped");
    const raw = await sharp(data, { raw: info })
        .extract({ left: b.x, top: b.y, width: b.width, height: b.height })
        .resize(width, height)
        .raw()
        .toBuffer(),
      pixels = Buffer.alloc(480 * 480 * 4);
    for (let y = 0; y < height; y++)
      raw.copy(
        pixels,
        ((top + y) * 480 + left) * 4,
        y * width * 4,
        (y + 1) * width * 4,
      );
    frames.push({
      pixels,
      durationMs: 100,
      foot: { x: 240, y: 462 },
      source: {
        file,
        sha256: hash(bytes),
        index,
        region: c,
        bounds: b,
        scale,
        placement: { x: left, y: top, width, height },
      },
    });
  }
  return frames;
}
await fs.mkdir(dir + "/sprites", { recursive: true });
await fs.mkdir(qa, { recursive: true });
const down = await original("sittingdown"),
  up = await original("standingup"),
  seat = (
    await generated(
      `generated/seated-attempt${id === "claude" ? 1 : 3}.png`,
      1,
      1,
      id === "claude" ? 396 : 375,
    )
  )[0];
const specs =
  id === "claude"
    ? [
        {
          family: "gentle",
          action: "sittingdown",
          loop: "once",
          frames: [down[0], { ...seat, durationMs: 90 }, ...down.slice(1)],
          notes:
            "Insert one genuine halfway knee/hand pose between old0 and1. Existing endpoint and all original frames remain pixel-identical.",
        },
        {
          family: "gentle",
          action: "standingup",
          loop: "once",
          frames: [...up.slice(0, 6), { ...seat, durationMs: 90 }, up[6]],
          notes:
            "Reuse exactly the same new midpoint in reverse before original standing endpoint.",
        },
        {
          family: "runtime",
          action: "falling",
          loop: "repeat",
          frames: await generated("generated/falling-attempt1.png", 2, 2, 397),
          notes:
            "Steady forward-tilted four-pose hair/wrist loop, matching landing entry rather than snapping upright at wrap.",
        },
      ]
    : [
        {
          family: "gentle",
          action: "sittingdown",
          loop: "once",
          frames: [down[0], { ...seat, durationMs: 140 }, ...down.slice(3)],
          notes:
            "Replace old1/2 with one shallow-crouch pose that retains idle skirt length, short legs and tail volume. Original0 and3..8 unchanged.",
        },
        {
          family: "gentle",
          action: "standingup",
          loop: "once",
          frames: [...up.slice(0, 6), { ...seat, durationMs: 140 }, up[8]],
          notes:
            "Use exactly the new shallow-crouch pose in reverse; old6/7 replaced, old0..5 and8 unchanged.",
        },
      ];
if (id === "claude") {
  const flutter = await original("flutter"),
    fall = await original("falling"),
    bottom = [430, 438, 446, 454],
    duration = [80, 70, 80, 90];
  specs.push({
    family: "runtime",
    action: "flutter",
    loop: "once",
    frames: [
      ...flutter,
      ...fall.map((f, i) => translateAirborne(f, bottom[i], duration[i])),
    ],
    notes:
      "Preserve all12 original flutter frames, then play old falling0..3 once to turn from upright flailing into the new forward-pitched falling loop. Appended poses only translate vertically (no scaling or local edits); alpha<128 cleared on these four appended frames. Visible bottoms progress425→430→438→446→454→new falling462.",
  });
}
const actions = [];
for (const s of specs) {
  const width = s.frames.length * 480,
    atlas = Buffer.alloc(width * 480 * 4),
    frames = [];
  for (const [i, f] of s.frames.entries()) {
    for (let y = 0; y < 480; y++)
      f.pixels.copy(
        atlas,
        (y * width + i * 480) * 4,
        y * 480 * 4,
        (y + 1) * 480 * 4,
      );
    const b = box(f.pixels, 480, { x: 0, y: 0, width: 480, height: 480 });
    if (
      b.y + b.height > f.foot.y ||
      (s.action !== "flutter" && f.foot.y - b.y - b.height > 2)
    )
      throw Error("Support " + s.action + "/" + i);
    frames.push({
      region: { x: i * 480, y: 0, width: 480, height: 480 },
      foot: f.foot,
      durationMs: f.durationMs,
      source: f.source,
      visibleBounds: b,
    });
  }
  const bytes = await sharp(atlas, { raw: { width, height: 480, channels: 4 } })
      .webp({ lossless: true })
      .toBuffer(),
    image = `sprites/${s.action}.webp`;
  await fs.writeFile(dir + "/" + image, bytes);
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < atlas.length; i += 4)
    if (
      atlas[i + 3] !== decoded[i + 3] ||
      (atlas[i + 3] &&
        atlas.subarray(i, i + 4).compare(decoded.subarray(i, i + 4)))
    )
      throw Error("Pixel mismatch");
  actions.push({
    family: s.family,
    action: s.action,
    image,
    sha256: hash(bytes),
    loop: s.loop,
    frames,
    notes: s.notes,
    previous: {
      file: `originals/${s.action}.png`,
      sha256: hash(await fs.readFile(dir + `/originals/${s.action}.png`)),
    },
  });
  const parts = [],
    cols = Math.min(s.frames.length, 6),
    rows = Math.ceil(s.frames.length / cols);
  let text = "";
  for (const [i, f] of s.frames.entries()) {
    const x = (i % cols) * 240,
      y = Math.floor(i / cols) * 280 + 30;
    parts.push({
      input: await sharp(f.pixels, {
        raw: { width: 480, height: 480, channels: 4 },
      })
        .resize(240, 240)
        .png()
        .toBuffer(),
      left: x,
      top: y,
    });
    text += `<text x="${x + 8}" y="${y + 259}" font-family="Arial" font-size="16">${s.action}[${i}] ${f.durationMs}ms ${f.source.file.startsWith("generated") ? "NEW" : "old" + f.source.index}</text>`;
  }
  parts.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * 240}" height="${rows * 280 + 30}">${text}</svg>`,
    ),
    left: 0,
    top: 0,
  });
  await sharp({
    create: {
      width: cols * 240,
      height: rows * 280 + 30,
      channels: 4,
      background: "#eeeae4",
    },
  })
    .composite(parts)
    .png()
    .toFile(qa + `/v4-final-${s.action}.png`);
}
await fs.writeFile(
  dir + "/replacements.json",
  JSON.stringify({ version: 1, character: id, actions }, null, 2) + "\n",
);
await fs.writeFile(
  dir + "/processing-record.json",
  JSON.stringify(
    {
      method:
        "Alpha<128 cleared on generated inputs and four translated airborne transition poses; single uniform scale per generated sheet; cell center fixed to240 and generated alpha support bottom aligned462. Original retained frames raw-copied unchanged. Four old falling poses appended to flutter only translate vertically with scale1, explicitly recorded per frame. No local warping/compositing. Final atlases raw RGBA row copy then lossless WebP; visible RGBA equality verified.",
      script: "prepare.mjs",
      scriptSha256: hash(await fs.readFile(dir + "/prepare.mjs")),
      anchorsUnchanged: true,
      actions: actions.map((a) => ({
        action: a.action,
        frames: a.frames.map((f) => ({
          source: f.source,
          bounds: f.visibleBounds,
          region: f.region,
        })),
      })),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  id,
  actions.map((a) => ({
    action: a.action,
    frames: a.frames.length,
    top: a.frames.map((f) => f.visibleBounds.y),
  })),
);
