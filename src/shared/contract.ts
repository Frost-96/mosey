import { z } from "zod";
export const presentationSchema = z.strictObject({
  posture: z.enum(["resting", "tilt", "paw", "belly"]),
  actionId: z.number().int().nonnegative(),
  startedAt: z.number().nonnegative(),
  visibility: z.enum(["visible", "hidden"]),
});
export const inputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("click"),
    x: z.number().finite(),
    y: z.number().finite(),
    actionId: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("frame"),
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
