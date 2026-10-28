import { z } from "zod";
const finite = z.number().finite();
const rect = z.strictObject({
  x: finite,
  y: finite,
  width: finite.positive(),
  height: finite.positive(),
});
export const dockObservationSchema = z.strictObject({
  orientation: z.enum(["bottom", "left", "right"]),
  bounds: rect,
  contour: z
    .array(z.strictObject({ axis: finite, inward: finite }))
    .min(1)
    .max(16384),
  primaryDisplayID: finite.int().positive(),
});
export type DockObservation = z.infer<typeof dockObservationSchema>;
export const dockRuntimeRecordSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("environment"),
    protocol: z.literal(1),
    processID: finite.int().positive(),
    parentPID: finite.int().positive(),
  }),
  z.strictObject({
    type: z.literal("observation"),
    elapsed: finite.nonnegative(),
    sequence: finite.int().nonnegative(),
    sourceAgeSeconds: finite.nonnegative().nullable(),
    callbackAgeSeconds: finite.nonnegative().nullable(),
    idle: z.boolean(),
    reason: z.string().max(160),
    observation: dockObservationSchema.nullable(),
  }),
]);
