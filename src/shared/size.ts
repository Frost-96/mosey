import { z } from "zod";
export const petSizeSchema = z.number().int().min(70).max(240).multipleOf(10);
export type PetSize = z.infer<typeof petSizeSchema>;

// The preset sizes offered by the menus and the settings window.
export const sizePresets = [
  { size: 70, label: "小" },
  { size: 160, label: "中" },
  { size: 240, label: "大" },
] as const satisfies readonly { size: PetSize; label: string }[];
