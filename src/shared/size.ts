import { z } from "zod";
export const petSizeSchema = z.number().int().min(70).max(240).multipleOf(10);
export type PetSize = z.infer<typeof petSizeSchema>;
