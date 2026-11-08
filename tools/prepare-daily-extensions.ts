import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

const characters = ["whale", "claude", "gemini", "gpt"] as const;
const frameSize = 480;
const alphaThreshold = 128;
type Region = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Idle = { image: string; frames: { region: Region; foot: Point }[] };

const gentleSequences = {
  looking: {
    loop: "once",
    indices: [-1, 0, 1, 0, 2, 3, -1],
    durations: [180, 220, 650, 220, 650, 240, 180],
  },
  sittingdown: {
    loop: "once",
    indices: [-1, 4, 5, 6, 7, 8],
    durations: [180, 160, 220, 260, 300, 400],
  },
  sitting: {
    loop: "repeat",
    indices: [8, 9, 10, 11, 9, 8],
    durations: [1300, 550, 1000, 650, 550, 1100],
  },
  standingup: {
    loop: "once",
    indices: [8, 7, 6, 5, 4, -1],
    durations: [200, 200, 260, 260, 220, 180],
  },
  yawning: {
    loop: "once",
    indices: [-1, 12, 13, 14, 15, -1],
    durations: [180, 300, 1000, 450, 240, 180],
  },
} as const;

const expressiveSequences = {
  petted: {
    loop: "once",
    indices: [-1, 0, 1, 2, 1, 3, -1],
    durations: [180, 180, 300, 850, 240, 240, 180],
  },
  grooming: {
    loop: "once",
    indices: [-1, 4, 5, 6, 7, -1],
    durations: [180, 250, 500, 550, 300, 180],
  },
  celebrating: {
    loop: "once",
    indices: [-1, 8, 9, 10, 9, 10, 11, -1],
    durations: [180, 220, 240, 200, 240, 200, 300, 180],
  },
  habit: {
    loop: "once",
    indices: [-1, 12, 13, 14, 15, -1],
    durations: [180, 350, 1000, 850, 350, 180],
  },
} as const;

const packageName = process.argv[2] ?? "gentle-daily-v1";
if (!["gentle-daily-v1", "expressive-daily-v1"].includes(packageName))
  throw new Error(`Unknown material package: ${packageName}`);
const sequences: Record<
  string,
  {
    loop: "once" | "repeat";
    indices: readonly number[];
    durations: readonly number[];
  }
> = packageName === "gentle-daily-v1" ? gentleSequences : expressiveSequences;

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function bounds(pixels: Buffer, width: number, region: Region): Region {
  let left = region.x + region.width;
  let top = region.y + region.height;
  let right = -1;
  let bottom = -1;
  for (let y = region.y; y < region.y + region.height; y++)
    for (let x = region.x; x < region.x + region.width; x++)
      if (pixels[(y * width + x) * 4 + 3]! >= alphaThreshold) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  if (right < left || bottom < top) throw new Error("Empty source frame");
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

async function extract(
  pixels: Buffer,
  width: number,
  height: number,
  r: Region,
) {
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
    .png()
    .toBuffer();
}

// Read all inputs before creating any output, so a missing source fails cleanly.
const inputs = await Promise.all(
  characters.map(async (character) => {
    const characterDirectory = `src/assets/characters/${character}`;
    const directory = `${characterDirectory}/extensions/${packageName}`;
    const files = await readdir(directory);
    const sourceFile = ["source-v1.png", "source.png"].find((file) =>
      files.includes(file),
    );
    if (!sourceFile) throw new Error(`Missing source sheet: ${directory}`);
    const generationRecord = await readFile(
      `${directory}/generation-record.json`,
    );
    JSON.parse(generationRecord.toString());
    const configuration = JSON.parse(
      await readFile(`${characterDirectory}/processing.json`, "utf8"),
    ) as { resting: Idle };
    const idle = configuration.resting;
    const idleBytes = await readFile(`${characterDirectory}/${idle.image}`);
    const sourceBytes = await readFile(`${directory}/${sourceFile}`);
    return {
      character,
      directory,
      sourceFile,
      sourceBytes,
      generationRecord,
      idle,
      idleBytes,
    };
  }),
);

// Prepare every character in memory before writing, including clipping checks.
const prepared = [];
for (const input of inputs) {
  const { data, info } = await sharp(input.sourceBytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let offset = 3; offset < data.length; offset += 4)
    if (data[offset]! < alphaThreshold) data[offset] = 0;
  const idleFrame = input.idle.frames[0]!;
  if (
    idleFrame.region.width !== frameSize ||
    idleFrame.region.height !== frameSize
  )
    throw new Error(`Expected 480px reference frame: ${input.character}`);
  const idlePixels = await sharp(input.idleBytes)
    .extract({
      left: idleFrame.region.x,
      top: idleFrame.region.y,
      width: frameSize,
      height: frameSize,
    })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const canvas = { x: 0, y: 0, width: frameSize, height: frameSize };
  const idleBounds = bounds(idlePixels, frameSize, canvas);
  const cells = Array.from({ length: 16 }, (_, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const x = Math.round((column * info.width) / 4);
    const y = Math.round((row * info.height) / 4);
    return {
      x,
      y,
      width: Math.round(((column + 1) * info.width) / 4) - x,
      height: Math.round(((row + 1) * info.height) / 4) - y,
    };
  });
  const sourceBounds = cells.map((cell) => bounds(data, info.width, cell));
  const scale = idleBounds.height / sourceBounds[0]!.height;
  const foot = idleFrame.foot;
  const rasters = new Map<number, Buffer>([
    [-1, await extract(idlePixels, frameSize, frameSize, canvas)],
  ]);
  const processing = new Map([
    [
      -1,
      {
        sourceFile: `../../${input.idle.image}`,
        sourceRegion: idleFrame.region,
        sourceCell: idleFrame.region,
        scale: 1,
        translation: { x: -idleFrame.region.x, y: -idleFrame.region.y },
        rasterPlacement: { x: 0, y: 0, width: frameSize, height: frameSize },
      },
    ],
  ]);
  for (const [index, region] of sourceBounds.entries()) {
    const cell = cells[index]!;
    const columnCenter = cell.x + cell.width / 2;
    const width = Math.round(region.width * scale);
    const height = Math.round(region.height * scale);
    const left = Math.round(foot.x + (region.x - columnCenter) * scale);
    const top = foot.y - height;
    if (
      left < 0 ||
      top < 0 ||
      left + width > frameSize ||
      top + height > frameSize
    )
      throw new Error(
        `Clipped ${input.character} source frame ${index}: ${JSON.stringify({ left, top, width, height, scale })}`,
      );
    const tile = await sharp(
      await extract(data, info.width, info.height, region),
    )
      .resize(width, height, { fit: "fill" })
      .png()
      .toBuffer();
    const raster = await sharp({
      create: {
        width: frameSize,
        height: frameSize,
        channels: 4,
        background: "#00000000",
      },
    })
      .composite([{ input: tile, left, top }])
      .png()
      .toBuffer();
    const pixels = await sharp(raster).ensureAlpha().raw().toBuffer();
    const outputBounds = bounds(pixels, frameSize, canvas);
    if (outputBounds.y + outputBounds.height > foot.y)
      throw new Error(`Pixels below support: ${input.character}/${index}`);
    rasters.set(index, raster);
    processing.set(index, {
      sourceFile: input.sourceFile,
      sourceRegion: region,
      sourceCell: cell,
      scale,
      translation: {
        x: foot.x - columnCenter * scale,
        y: foot.y - (region.y + region.height) * scale,
      },
      rasterPlacement: { x: left, y: top, width, height },
    });
  }
  const actions = [];
  for (const [action, sequence] of Object.entries(sequences)) {
    const durations =
      action === "yawning"
        ? input.character === "gemini"
          ? [180, 300, 750, 450, 240, 180]
          : [180, 300, 450, 750, 240, 180]
        : action === "habit" && input.character === "claude"
          ? [180, 350, 2000, 1000, 500, 180]
          : sequence.durations;
    const width = frameSize * sequence.indices.length;
    const atlasPixels = Buffer.alloc(width * frameSize * 4);
    // Copy RGBA directly: compositing would round premultiplied edge colors.
    for (const [position, index] of sequence.indices.entries()) {
      const pixels = await sharp(rasters.get(index)!)
        .ensureAlpha()
        .raw()
        .toBuffer();
      for (let row = 0; row < frameSize; row++)
        pixels.copy(
          atlasPixels,
          (row * width + position * frameSize) * 4,
          row * frameSize * 4,
          (row + 1) * frameSize * 4,
        );
    }
    const bytes = await sharp(atlasPixels, {
      raw: { width, height: frameSize, channels: 4 },
    })
      .webp({ lossless: true })
      .toBuffer();
    const metadata = await sharp(bytes).metadata();
    if (
      !bytes.length ||
      metadata.width !== width ||
      metadata.height !== frameSize
    )
      throw new Error(`Invalid output: ${input.character}/${action}`);
    actions.push({
      action,
      bytes,
      manifest: {
        image: `sprites/${action}.webp`,
        sha256: hash(bytes),
        width,
        height: frameSize,
        loop: sequence.loop,
        ...(action === "standingup"
          ? {
              reuse:
                "Reverses the authored sitting-down poses; no new rising poses were generated.",
            }
          : {}),
        frames: sequence.indices.map((index, position) => ({
          region: {
            x: position * frameSize,
            y: 0,
            width: frameSize,
            height: frameSize,
          },
          foot,
          durationMs: durations[position],
          sourceFrameIndex: index,
          processing: processing.get(index),
        })),
      },
    });
  }
  prepared.push({
    input,
    actions,
    scale,
    sourceWidth: info.width,
    sourceHeight: info.height,
  });
}

for (const { input, actions, scale, sourceWidth, sourceHeight } of prepared) {
  await mkdir(`${input.directory}/sprites`, { recursive: true });
  for (const { action, bytes } of actions)
    await writeFile(`${input.directory}/sprites/${action}.webp`, bytes);
  const manifest = {
    format: "mosey-action-material-candidate",
    version: 1,
    character: input.character,
    package: packageName,
    status: "candidate-materials-not-runtime-format",
    integration:
      "Standalone authored materials. Not registered in the running app's actions or character processing configuration.",
    generator: "tools/prepare-daily-extensions.ts",
    rebuild: `node tools/prepare-daily-extensions.ts ${packageName}`,
    frameSize,
    pixelRatio: 2,
    hitAlphaThreshold: alphaThreshold,
    source: {
      file: input.sourceFile,
      sha256: hash(input.sourceBytes),
      width: sourceWidth,
      height: sourceHeight,
      grid: { columns: 4, rows: 4, boundaries: "round(index * dimension / 4)" },
      record: "generation-record.json",
      recordSha256: hash(input.generationRecord),
    },
    reference: {
      file: `../../${input.idle.image}`,
      sha256: hash(input.idleBytes),
      frameIndex: 0,
    },
    processing: {
      uniformScale: scale,
      scaleBasis:
        "Source first frame alpha>=128 height matched to existing resting first frame alpha>=128 height.",
      alphaCleanup:
        "Set only alpha values below 128 to zero before resizing; preserve remaining RGBA values.",
      alignment:
        "Each source column's fixed cell center maps to resting foot.x; each frame's bottom contact maps to resting foot.y. No per-frame scale or silhouette centering.",
      coordinates:
        "sourceRegion and sourceCell use source-image pixels; translation maps scaled global source coordinates to a 480px frame. rasterPlacement records integer rounding.",
    },
    actions: Object.fromEntries(
      actions.map(({ action, manifest }) => [action, manifest]),
    ),
  };
  await writeFile(
    `${input.directory}/manifest.json`,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    `${input.character}: ${actions.length} action strips, uniform scale ${scale.toFixed(5)}, all frames inside ${frameSize}px`,
  );
}
