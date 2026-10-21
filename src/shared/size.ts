import { z } from "zod";

export const petSizeSchema = z.enum(["small", "medium", "large"]);
export type PetSize = z.infer<typeof petSizeSchema>;
// Desktop coordinates are DIP; atlas coordinates are pixels, independent of DPR.
// All poses share a bottom-center foot. Future movement uses this same geometry.
export function petGeometry(size: PetSize) {
  const side = { small: 180, medium: 240, large: 300 }[size];
  return { side, foot: { x: side / 2, y: side }, assetScale: side / 240 };
}
