import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import sharp from "sharp";
import { format } from "prettier";

type Region = { x: number; y: number; width: number; height: number };
type Frame = {
  region: Region;
  foot: { x: number; y: number };
  durationMs: number;
  readableRegions?: Region[];
  [key: string]: unknown;
};
type Replacement = {
  family: "runtime" | "gentle" | "expressive";
  action: string;
  image: string;
  sha256: string;
  loop: "once" | "repeat";
  frames: Frame[];
  notes: string;
};
type Document = {
  actions: Record<string, Record<string, unknown>>;
  revisions?: { id: string; [key: string]: unknown }[];
  [key: string]: unknown;
};
const id = "motion-coherence-v3";
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const json = async (path: string, value: unknown) =>
  writeFile(
    path,
    await format(JSON.stringify(value, null, 2), { parser: "json" }),
  );

export async function applyMotionRevisions(
  options: { runtime?: boolean; extensions?: boolean } = {},
) {
  for (const character of ["whale", "claude", "gemini", "gpt"]) {
    const root = `src/assets/characters/${character}`;
    const directory = `${root}/extensions/${id}`;
    const bytes = await readFile(`${directory}/replacements.json`).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!bytes) continue;
    const revision = JSON.parse(bytes.toString()) as {
      actions: Replacement[];
    };
    const selected = revision.actions.filter((a) =>
      a.family === "runtime"
        ? options.runtime !== false
        : options.extensions !== false,
    );
    for (const family of ["runtime", "gentle", "expressive"] as const) {
      const actions = selected.filter((a) => a.family === family);
      if (!actions.length) continue;
      const target =
        family === "runtime" ? root : `${root}/extensions/${family}-daily-v2`;
      const manifestPath = `${target}/${family === "runtime" ? "adoption.json" : "manifest.json"}`;
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as Document;
      const processing =
        family === "runtime"
          ? (JSON.parse(
              await readFile(`${root}/processing.json`, "utf8"),
            ) as Record<string, unknown>)
          : undefined;
      for (const action of actions) {
        const previous = manifest.actions[action.action];
        if (!previous)
          throw new Error(`Unknown action ${character}/${action.action}`);
        const image = await readFile(`${directory}/${action.image}`);
        if (hash(image) !== action.sha256)
          throw new Error(
            `Revision hash mismatch: ${character}/${action.action}`,
          );
        const raster = await sharp(image)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (!action.frames.length) throw new Error("Empty revised action");
        for (const frame of action.frames) {
          const r = frame.region;
          if (
            r.width !== 480 ||
            r.height !== 480 ||
            r.x < 0 ||
            r.y < 0 ||
            r.x + r.width > raster.info.width ||
            r.y + r.height > raster.info.height ||
            !Number.isInteger(frame.durationMs) ||
            frame.durationMs <= 0
          )
            throw new Error(
              `Invalid revised frame: ${character}/${action.action}`,
            );
          let opaque = 0;
          for (let y = 0; y < r.height; y++)
            for (let x = 0; x < r.width; x++)
              if (
                raster.data[
                  ((r.y + y) * raster.info.width + r.x + x) * 4 + 3
                ]! >= 128
              ) {
                opaque++;
                if (y >= frame.foot.y)
                  throw new Error(
                    `Revised pose below support: ${character}/${action.action}`,
                  );
              }
          if (!opaque) throw new Error("Empty revised pose");
        }
        const imagePath = `sprites/${action.action}.webp`;
        await writeFile(`${target}/${imagePath}`, image);
        const provenance = {
          id,
          file:
            family === "runtime"
              ? `extensions/${id}/replacements.json`
              : `../${id}/replacements.json`,
          sha256: hash(bytes),
          image: action.image,
          notes: action.notes,
        };
        if (processing) {
          const frames = action.frames.map(
            ({ region, foot, durationMs, readableRegions }) => ({
              region,
              foot,
              durationMs,
              ...(readableRegions ? { readableRegions } : {}),
            }),
          );
          processing[action.action] = {
            image: imagePath,
            sha256: action.sha256,
            loop: action.loop,
            frames,
          };
          manifest.actions[action.action] = {
            ...previous,
            image: imagePath,
            sha256: action.sha256,
            previewFrames: frames.map((f) => ({ ...f, anchor: f.foot })),
            previewLoop: action.loop,
            revision: provenance,
          };
        } else {
          manifest.actions[action.action] = {
            ...previous,
            image: imagePath,
            sha256: action.sha256,
            width: raster.info.width,
            height: raster.info.height,
            loop: action.loop,
            frames: action.frames,
            revision: provenance,
          };
        }
      }
      manifest.revisions = [
        ...(manifest.revisions ?? []).filter((r) => r.id !== id),
        {
          id,
          actions: actions.map((a) => a.action),
          file:
            family === "runtime"
              ? `extensions/${id}/replacements.json`
              : `../${id}/replacements.json`,
          sha256: hash(bytes),
        },
      ];
      await json(manifestPath, manifest);
      if (processing) await json(`${root}/processing.json`, processing);
      console.log(
        `${character}/${family}: applied ${actions.length} motion revisions`,
      );
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await applyMotionRevisions();
