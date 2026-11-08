import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { format } from "prettier";
import { applyMotionRevisions } from "./apply-motion-revisions.ts";

type Region = { x: number; y: number; width: number; height: number };
type Frame = {
  region: Region;
  foot: { x: number; y: number };
  durationMs: number;
  sourceFrameIndex: number;
};
type Action = { image: string; sha256: string; loop: string; frames: Frame[] };
type Manifest = { actions: Record<string, Action> };
type Refinements = {
  actions: Record<
    string,
    {
      image: string;
      sha256: string;
      record: string;
      recordSha256: string;
      frames: Region[];
      sequence: {
        kind: "original" | "refinement";
        index: number;
        durationMs: number;
      }[];
      notes: string;
    }
  >;
};
const size = 480;
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const basePaths: Record<string, number[]> = {
  looking: [-1, 0, 1, 2, 3, -1],
  sittingdown: [-1, 4, 5, 6, 7, 8],
  sitting: [8, 9, 10, 11, 8],
  standingup: [8, 7, 6, 5, 4, -1],
  yawning: [-1, 12, 13, 14, 15, -1],
  petted: [-1, 0, 1, 2, 3, -1],
  grooming: [-1, 4, 5, 6, 7, -1],
  celebrating: [-1, 8, 9, 10, 9, 10, 11, -1],
  habit: [-1, 12, 13, 14, 15, -1],
};
const keyDurations: Record<string, number[]> = {
  looking: [100, 80, 320, 320, 100, 150],
  sittingdown: [100, 70, 100, 120, 160, 120],
  sitting: [800, 180, 500, 200, 400],
  standingup: [100, 120, 120, 100, 80, 150],
  yawning: [100, 150, 180, 550, 130, 150],
  petted: [100, 80, 180, 500, 120, 150],
  grooming: [100, 90, 200, 200, 110, 150],
  celebrating: [100, 100, 90, 80, 90, 80, 100, 150],
  habit: [100, 150, 800, 350, 150, 150],
};

function bounds(data: Buffer, width: number, region: Region): Region {
  let left = Infinity,
    top = Infinity,
    right = -1,
    bottom = -1;
  for (let y = region.y; y < region.y + region.height; y++)
    for (let x = region.x; x < region.x + region.width; x++)
      if (data[(y * width + x) * 4 + 3]! >= 128) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
  if (right < left) throw new Error("Empty frame");
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

for (const character of ["whale", "claude", "gemini", "gpt"])
  for (const family of ["gentle", "expressive"]) {
    const parent = `src/assets/characters/${character}/extensions`;
    const previous = `${parent}/${family}-daily-v1`;
    const directory = `${parent}/${family}-daily-v2`;
    const oldBytes = await readFile(`${previous}/manifest.json`);
    const old = JSON.parse(oldBytes.toString()) as Manifest;
    const refinementBytes = await readFile(
      `${directory}/refinements.json`,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const refinements = refinementBytes
      ? (JSON.parse(refinementBytes.toString()) as Refinements)
      : undefined;
    const selectionBytes = await readFile(`${directory}/selection.json`);
    const selection = JSON.parse(selectionBytes.toString()) as {
      acceptedIndices: number[];
    };
    const accepted = new Set(selection.acceptedIndices);
    if (
      selection.acceptedIndices.some(
        (i) => !Number.isInteger(i) || i < 0 || i > 15,
      )
    )
      throw new Error(`Invalid selected frame: ${directory}`);
    const record = await readFile(`${directory}/generation-record.json`);
    const sourceBytes = await readFile(`${directory}/inbetweens.png`);
    const { data, info } = await sharp(sourceBytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let offset = 3; offset < data.length; offset += 4)
      if (data[offset]! < 128) data[offset] = 0;

    const originals = new Map<
      number,
      { pixels: Buffer; foot: Frame["foot"]; source: object }
    >();
    for (const action of Object.values(old.actions)) {
      const bytes = await readFile(`${previous}/${action.image}`);
      if (hash(bytes) !== action.sha256)
        throw new Error(`Changed v1 pixels: ${previous}/${action.image}`);
      for (const frame of action.frames)
        if (!originals.has(frame.sourceFrameIndex)) {
          const r = frame.region;
          const pixels = await sharp(bytes)
            .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
            .ensureAlpha()
            .raw()
            .toBuffer();
          originals.set(frame.sourceFrameIndex, {
            pixels,
            foot: frame.foot,
            source: {
              file: `../${family}-daily-v1/${action.image}`,
              sha256: action.sha256,
              region: r,
            },
          });
        }
    }
    const canvas = { x: 0, y: 0, width: size, height: size };
    const cells = Array.from({ length: 16 }, (_, index) => {
      const col = index % 4,
        row = Math.floor(index / 4);
      const x = Math.round((col * info.width) / 4),
        y = Math.round((row * info.height) / 4);
      return {
        x,
        y,
        width: Math.round(((col + 1) * info.width) / 4) - x,
        height: Math.round(((row + 1) * info.height) / 4) - y,
      };
    });
    const sourceBounds = cells.map((cell) => bounds(data, info.width, cell));
    // One fixed scale for the whole sheet; never resize an individual posture.
    const scale =
      bounds(originals.get(0)!.pixels, size, canvas).height /
      sourceBounds[0]!.height;
    const foot = originals.get(-1)!.foot;
    const mids = new Map<number, { pixels: Buffer; source: object }>();
    const pairs = Array.from({ length: 16 }, (_, index) => ({
      index,
      from: index,
      to:
        index % 4 === 3
          ? family === "gentle" && index === 7
            ? 8
            : index - 3
          : index + 1,
    }));
    for (const index of accepted) {
      const r = sourceBounds[index]!,
        cell = cells[index]!;
      const width = Math.round(r.width * scale),
        height = Math.round(r.height * scale);
      const left = Math.round(foot.x + (r.x - cell.x - cell.width / 2) * scale),
        top = foot.y - height;
      if (left < 0 || top < 0 || left + width > size || top + height > size)
        throw new Error(`Clipped ${directory} intermediate ${index}`);
      const tile = await sharp(data, {
        raw: { width: info.width, height: info.height, channels: 4 },
      })
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
      mids.set(index, {
        pixels,
        source: {
          file: "inbetweens.png",
          index,
          pair: pairs[index],
          region: r,
          cell,
          scale,
          placement: { x: left, y: top, width, height },
        },
      });
    }
    const actions: Record<string, object> = {};
    const used = new Set<number>();
    let focusedPoseCount = 0;
    await mkdir(`${directory}/sprites`, { recursive: true });
    for (const [action, oldAction] of Object.entries(old.actions)) {
      const path = basePaths[action]!;
      const durations = [...keyDurations[action]!];
      if (action === "yawning" && character === "gemini") {
        durations[2] = 550;
        durations[3] = 150;
      }
      if (action === "habit" && character === "claude") {
        durations[2] = 1800;
        durations[3] = 450;
      }
      const sequence: {
        pixels: Buffer;
        durationMs: number;
        kind: string;
        index: number;
        source: object;
      }[] = [];
      const focused = refinements?.actions[action];
      for (let position = 0; !focused && position < path.length; position++) {
        const index = path[position]!;
        if (position > 0 && index >= 0) {
          // Last pose of a row is near neutral: use its return midpoint for entry.
          const from =
            path[position - 1] === -1
              ? Math.floor(index / 4) * 4 + 3
              : path[position - 1]!;
          const pair = pairs.find(
            (p) =>
              accepted.has(p.index) &&
              ((p.from === from && p.to === index) ||
                (p.from === index && p.to === from)),
          );
          if (pair) {
            const mid = mids.get(pair.index)!;
            used.add(pair.index);
            sequence.push({
              ...mid,
              durationMs:
                action === "celebrating" ? 65 : action === "sitting" ? 120 : 90,
              kind: "inbetween",
              index: pair.index,
            });
          }
        }
        sequence.push({
          ...originals.get(index)!,
          durationMs: durations[position]!,
          kind: "original",
          index,
        });
      }
      if (focused) {
        focusedPoseCount += new Set(
          focused.sequence
            .filter((frame) => frame.kind === "refinement")
            .map((frame) => frame.index),
        ).size;
        const focusedBytes = await readFile(`${directory}/${focused.image}`);
        const focusedRecord = await readFile(`${directory}/${focused.record}`);
        if (
          hash(focusedBytes) !== focused.sha256 ||
          hash(focusedRecord) !== focused.recordSha256
        )
          throw new Error(`Changed focused material: ${character}/${action}`);
        const raster = await sharp(focusedBytes)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const focusedFrames: Buffer[] = [];
        for (const region of focused.frames) {
          if (
            region.width !== size ||
            region.height !== size ||
            region.x < 0 ||
            region.y < 0 ||
            region.x + size > raster.info.width ||
            region.y + size > raster.info.height
          )
            throw new Error(`Invalid focused geometry: ${character}/${action}`);
          const pixels = await sharp(raster.data, { raw: raster.info })
            .extract({
              left: region.x,
              top: region.y,
              width: size,
              height: size,
            })
            .raw()
            .toBuffer();
          const visible = bounds(pixels, size, canvas);
          if (Math.abs(visible.y + visible.height - foot.y) > 2)
            throw new Error(
              `Focused pose outside support tolerance: ${character}/${action}`,
            );
          focusedFrames.push(pixels);
        }
        for (const item of focused.sequence) {
          if (!Number.isInteger(item.durationMs) || item.durationMs <= 0)
            throw new Error(`Invalid focused timing: ${character}/${action}`);
          if (item.kind === "original") {
            const frame = originals.get(item.index);
            if (!frame) throw new Error(`Missing original pose: ${item.index}`);
            sequence.push({
              ...frame,
              durationMs: item.durationMs,
              kind: "original",
              index: item.index,
            });
          } else {
            const pixels = focusedFrames[item.index];
            if (!pixels) throw new Error(`Missing focused pose: ${item.index}`);
            sequence.push({
              pixels,
              durationMs: item.durationMs,
              kind: "inbetween",
              index: 100 + item.index,
              source: {
                file: focused.image,
                sha256: focused.sha256,
                region: focused.frames[item.index],
                index: 100 + item.index,
                record: focused.record,
                recordSha256: focused.recordSha256,
              },
            });
          }
        }
      }
      const width = size * sequence.length;
      const pixels = Buffer.alloc(width * size * 4);
      for (const [i, frame] of sequence.entries())
        for (let y = 0; y < size; y++)
          frame.pixels.copy(
            pixels,
            (y * width + i * size) * 4,
            y * size * 4,
            (y + 1) * size * 4,
          );
      const bytes = await sharp(pixels, {
        raw: { width, height: size, channels: 4 },
      })
        .webp({ lossless: true })
        .toBuffer();
      const image = `sprites/${action}.webp`;
      await writeFile(`${directory}/${image}`, bytes);
      actions[action] = {
        image,
        sha256: hash(bytes),
        width,
        height: size,
        loop: oldAction.loop,
        ...(focused ? { refinement: focused.notes } : {}),
        frames: sequence.map((f, i) => ({
          region: { x: i * size, y: 0, width: size, height: size },
          foot,
          durationMs: f.durationMs,
          kind: f.kind,
          sourceFrameIndex: f.index,
          source: f.source,
        })),
      };
    }
    await writeFile(
      `${directory}/manifest.json`,
      await format(
        JSON.stringify(
          {
            format: "mosey-action-material-candidate",
            version: 2,
            character,
            package: `${family}-daily-v2`,
            status: "candidate-materials-not-runtime-format",
            integration:
              "Standalone material preview; not registered in the desktop application's behavior.",
            generator: "tools/prepare-inbetween-extensions.ts",
            frameSize: size,
            pixelRatio: 2,
            hitAlphaThreshold: 128,
            previous: {
              file: `../${family}-daily-v1/manifest.json`,
              sha256: hash(oldBytes),
            },
            source: {
              file: "inbetweens.png",
              sha256: hash(sourceBytes),
              width: info.width,
              height: info.height,
              record: "generation-record.json",
              recordSha256: hash(record),
            },
            selection: {
              file: "selection.json",
              sha256: hash(selectionBytes),
              acceptedIndices: [...accepted],
              usedIndices: [...used].sort((a, b) => a - b),
            },
            ...(refinementBytes
              ? {
                  refinements: {
                    file: "refinements.json",
                    sha256: hash(refinementBytes),
                  },
                }
              : {}),
            processing: {
              uniformScale: scale,
              alphaCleanup:
                "Set alpha<128 to zero; no crossfade or generated pose warping.",
              alignment:
                "Fixed cell horizontal center and existing contact baseline; fixed scale across the sheet.",
              originalPixels:
                "Copied from v1 atlases as raw RGBA without compositing.",
            },
            actions,
          },
          null,
          2,
        ),
        { parser: "json" },
      ),
    );
    console.log(
      `${character}/${family}: ${Object.keys(actions).length} clips, ${used.size + focusedPoseCount} new poses used`,
    );
  }

await applyMotionRevisions({ runtime: false });
