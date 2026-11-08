import { z } from "zod";
import { atlasSchema } from "./assets.ts";
import {
  characterIdentitySchema,
  characterVersionSchema,
} from "./character-catalog.ts";
import { petSizeSchema } from "./size.ts";
import {
  baseActions,
  characterCapabilities,
  dailyActionDefinitions,
  extensionRequirements,
} from "./character-capabilities.ts";

const walkingMotionSchema = z.strictObject({
  cycleDistancePixels: z.number().positive(),
  cyclesPerWalk: z.number().int().positive(),
  pixelRatio: z.number().positive(),
  referenceWindowSize: petSizeSchema,
  bodyTravelSamples: z.array(z.number().finite()).min(2),
});

// This is the prepared-resource contract, not the future public ZIP format.
export const characterPackageSchema = characterIdentitySchema
  .extend({
    version: z.literal(1),
    atlases: z.array(atlasSchema).min(1),
    walking: walkingMotionSchema.optional(),
  })
  .superRefine((character, context) => {
    const actions = character.atlases.map((atlas) => atlas.action);
    if (new Set(actions).size !== actions.length)
      context.addIssue({ code: "custom", message: "Duplicate actions" });
    for (const action of baseActions)
      if (!actions.includes(action))
        context.addIssue({
          code: "custom",
          message: `Missing required action: ${action}`,
        });
    const required = new Set<string>(baseActions);
    for (const [behavior, dependencies] of Object.entries(
      extensionRequirements,
    )) {
      const present = dependencies.some(
        (action) => !required.has(action) && actions.includes(action),
      );
      const missing = dependencies.filter(
        (action) => !actions.includes(action),
      );
      if (present && missing.length)
        context.addIssue({
          code: "custom",
          message: `Incomplete ${behavior}: missing ${missing.join(", ")}`,
        });
    }
    for (const atlas of character.atlases) {
      const loop = [
        "resting",
        "walking",
        "dragging",
        "falling",
        "sleeping",
        "sitting",
      ].includes(atlas.action)
        ? "repeat"
        : "once";
      if (atlas.loop !== loop)
        context.addIssue({
          code: "custom",
          message: `${atlas.action} must use ${loop} playback`,
        });
    }
    const motion = character.walking;
    const walk = character.atlases.find((atlas) => atlas.action === "walking");
    if (
      motion &&
      walk &&
      (motion.bodyTravelSamples.length !== walk.frames.length + 1 ||
        motion.bodyTravelSamples[0] !== 0 ||
        motion.bodyTravelSamples.at(-1) !== motion.cycleDistancePixels)
    )
      context.addIssue({
        code: "custom",
        message: "Walking samples do not match frames",
      });
  });
export type CharacterPackage = z.infer<typeof characterPackageSchema>;
export const preparedCharacterSchema = z.strictObject({
  ...characterIdentitySchema.shape,
  resourceVersion: characterVersionSchema,
  atlases: z.array(atlasSchema).min(1),
  images: z.record(
    z.string(),
    z.string().startsWith("mosey-asset://character/"),
  ),
});
export type PreparedCharacter = z.infer<typeof preparedCharacterSchema>;

// Daily loops start on their shared neutral pose. Preserve that hold or finish
// the current cycle before moving into another authored action.
export function characterLoopTimings(
  character: Pick<CharacterPackage, "atlases">,
) {
  const capabilities = characterCapabilities(
    character.atlases.map((a) => a.action),
  );
  if (
    !dailyActionDefinitions.some(({ capability }) =>
      capabilities.includes(capability),
    )
  )
    return undefined;
  const timing = (action: "resting" | "sitting") => {
    const atlas = character.atlases.find((a) => a.action === action);
    return atlas
      ? {
          durationMs: atlas.frames.reduce(
            (sum, frame) => sum + frame.durationMs,
            0,
          ),
          neutralMs: atlas.frames[0]!.durationMs,
        }
      : undefined;
  };
  return { resting: timing("resting"), sitting: timing("sitting") };
}

export function characterWalk(character: CharacterPackage) {
  const motion = character.walking;
  if (!motion) return undefined;
  const atlas = character.atlases.find((a) => a.action === "walking")!;
  const samples = motion.bodyTravelSamples;
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
