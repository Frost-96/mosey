import { atlasSchema, type Atlas } from "./assets";
import { z } from "zod";
import { petSizeSchema } from "./size";
import type { CharacterId } from "./character-catalog";
export type { CharacterId } from "./character-catalog";

const metadata = import.meta.glob("../assets/generated/**/*-atlas.json", {
  eager: true,
  import: "default",
});
const motions = import.meta.glob("../assets/characters/*/motion.json", {
  eager: true,
  import: "default",
});
const walkingMotionSchema = z.strictObject({
  cycleDistancePixels: z.number().positive(),
  cyclesPerWalk: z.number().int().positive(),
  pixelRatio: z.number().positive(),
  referenceWindowSize: petSizeSchema,
  bodyTravelSamples: z.array(z.number().finite()).min(2),
});

export function characterDirectory(character: CharacterId): string {
  return character === "corgi" ? "" : `${character}/`;
}

// Rendering and native hit geometry load the same complete action set.
export function characterAssets(character: CharacterId): Atlas[] {
  const directory = `../assets/generated/${characterDirectory(character)}`;
  const atlases = Object.entries(metadata)
    .filter(([file]) => file.slice(0, file.lastIndexOf("/") + 1) === directory)
    .map(([, value]) => atlasSchema.parse(value));
  const actions = new Set(atlases.map((atlas) => atlas.action));
  if (
    actions.size !== atlases.length ||
    atlasSchema.shape.action.options.some((action) => !actions.has(action))
  )
    throw new Error(`Incomplete or duplicate actions for ${character}`);
  return atlases;
}

export function characterWalk(character: CharacterId) {
  if (character === "corgi") return undefined;
  const motion = walkingMotionSchema.parse(
    motions[`../assets/characters/${character}/motion.json`],
  );
  const atlas = characterAssets(character).find((a) => a.action === "walking")!;
  const samples = motion.bodyTravelSamples;
  if (
    samples.length !== atlas.frames.length + 1 ||
    samples[0] !== 0 ||
    samples.at(-1) !== motion.cycleDistancePixels
  )
    throw new Error(`Walking samples do not match ${character} frames`);
  const cycleMs = atlas.frames.reduce(
    (total, frame) => total + frame.durationMs,
    0,
  );
  const durationMs = cycleMs * motion.cyclesPerWalk;
  return {
    durationMs,
    distance:
      (motion.cycleDistancePixels / motion.pixelRatio) * motion.cyclesPerWalk,
    referenceWindowSize: motion.referenceWindowSize,
    // Carry the preview's measured steps into desktop movement at every size.
    progress(elapsedMs: number) {
      if (elapsedMs >= durationMs) return 1;
      const elapsed = Math.max(0, elapsedMs);
      const cycle = Math.floor(elapsed / cycleMs);
      let local = elapsed % cycleMs;
      for (const [index, frame] of atlas.frames.entries()) {
        if (local < frame.durationMs) {
          const travel =
            samples[index]! +
            ((samples[index + 1]! - samples[index]!) * local) /
              frame.durationMs;
          return Math.max(
            0,
            (cycle + travel / motion.cycleDistancePixels) /
              motion.cyclesPerWalk,
          );
        }
        local -= frame.durationMs;
      }
      return 1;
    },
  };
}
