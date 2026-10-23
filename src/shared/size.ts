import { z } from "zod";
export const petSizeSchema = z.number().int().min(70).max(240).multipleOf(10);
export type PetSize = z.infer<typeof petSizeSchema>;
// Window side and foot are DIP; atlas coordinates remain independent of DPR.
export function petGeometry(side: PetSize) {
  return { side, foot: { x: side / 2, y: side }, assetScale: side / 240 };
}
