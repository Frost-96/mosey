import { z } from "zod";
export const presentationSchema = z.strictObject({
  posture: z.literal("resting"),
  visibility: z.enum(["visible", "hidden"]),
});
export const assetErrorSchema = z.string().min(1).max(500);
export const emptyRequestSchema = z.undefined();
export type Presentation = z.infer<typeof presentationSchema>;
export interface PetBridge {
  getPresentation(): Promise<Presentation>;
  onPresentation(listener: (presentation: Presentation) => void): () => void;
  reportAssetError(message: string): void;
}
export const channels = {
  getPresentation: "pet:get-presentation",
  presentation: "pet:presentation",
  assetError: "pet:asset-error",
} as const;
declare global {
  interface Window {
    mosey: PetBridge;
  }
}
