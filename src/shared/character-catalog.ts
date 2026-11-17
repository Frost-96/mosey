import { z } from "zod";

// Identity survives artwork and display-name changes (including whale → DeepSeek).
export const characterSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export type CharacterId = z.infer<typeof characterSchema>;
export const characterIdentitySchema = z.strictObject({
  id: characterSchema,
  name: z.string().trim().min(1).max(100),
});
export const characterVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const characterResourceSchema = z.strictObject({
  character: characterSchema,
  resourceVersion: characterVersionSchema,
});
export function characterResourceKey(
  value: z.infer<typeof characterResourceSchema>,
) {
  return `${value.character}:${value.resourceVersion}`;
}
// Settings asks for a thumbnail by identity alone; the main process resolves the
// current resource version and owns generation and caching behind this address.
export function characterThumbnailUrl(character: CharacterId) {
  return `mosey-asset://thumbnail/${character}`;
}
