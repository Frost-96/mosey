import { z } from "zod";
import { petSizeSchema } from "./size";
export const presentationSchema = z.strictObject({
  size: petSizeSchema,
  geometryRevision: z.number().int().nonnegative(),
  posture: z.enum([
    "resting",
    "walking",
    "stretching",
    "playing",
    "tilt",
    "paw",
    "belly",
    "dragging",
    "flutter",
    "falling",
    "landing",
  ]),
  direction: z.enum(["left", "right"]),
  actionId: z.number().int().nonnegative(),
  startedAt: z.number().nonnegative(),
  visibility: z.enum(["visible", "hidden"]),
});
export const inputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("press"),
    geometryRevision: z.number().int().nonnegative(),
    x: z.number().finite(),
    y: z.number().finite(),
    screenX: z.number().finite(),
    screenY: z.number().finite(),
    gestureId: z.number().int().nonnegative(),
    actionId: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("move"),
    screenX: z.number().finite(),
    screenY: z.number().finite(),
    gestureId: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.enum(["release", "cancel"]),
    gestureId: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("frame"),
    geometryRevision: z.number().int().nonnegative(),
    frame: z.number().int().nonnegative(),
    actionId: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("done"),
    actionId: z.number().int().nonnegative(),
  }),
]);
export type PetInput = z.infer<typeof inputSchema>;
export const assetErrorSchema = z.string().min(1).max(500);
export const emptyRequestSchema = z.undefined();
export type Presentation = z.infer<typeof presentationSchema>;
export interface PetBridge {
  getPresentation(): Promise<Presentation>;
  onPresentation(listener: (presentation: Presentation) => void): () => void;
  reportAssetError(message: string): void;
  input(event: PetInput): void;
}
export const channels = {
  getPresentation: "pet:get-presentation",
  presentation: "pet:presentation",
  assetError: "pet:asset-error",
  input: "pet:input",
} as const;
declare global {
  interface Window {
    mosey: PetBridge;
  }
}
