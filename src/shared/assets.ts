import { z } from "zod";
const integer = z.number().int().nonnegative();
const point = z.strictObject({ x: integer, y: integer });
const frame = z.strictObject({
  region: z.strictObject({
    x: integer,
    y: integer,
    width: integer.positive(),
    height: integer.positive(),
  }),
  durationMs: integer.positive(),
  foot: point,
  // Per-row opaque runs, in local frame pixels, from the same resized PNG.
  hitRows: z.array(z.array(z.tuple([integer, integer]))),
});
export const atlasSchema = z
  .strictObject({
    version: z.literal(1),
    action: z.literal("resting"),
    image: z.literal("idle-atlas.png"),
    width: integer.positive(),
    height: integer.positive(),
    pixelRatio: z.literal(2),
    loop: z.literal("repeat"),
    hitAlphaThreshold: z.literal(128),
    frames: z.array(frame).min(1),
  })
  .superRefine((atlas, context) => {
    for (const [index, frame] of atlas.frames.entries()) {
      const { region } = frame;
      if (
        region.x + region.width > atlas.width ||
        region.y + region.height > atlas.height ||
        frame.foot.x > region.width ||
        frame.foot.y > region.height ||
        frame.hitRows.length !== region.height ||
        frame.hitRows.some((row) =>
          row.some(([start, end]) => start >= end || end > region.width),
        )
      )
        context.addIssue({
          code: "custom",
          message: `Invalid frame ${index} geometry`,
        });
    }
  });
export type Atlas = z.infer<typeof atlasSchema>;
