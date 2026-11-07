import { z } from "zod";

// Keep the persisted whale identity when replacing its artwork with DeepSeek.
export const characterSchema = z.enum([
  "whale",
  "claude",
  "gemini",
  "gpt",
  "corgi",
]);
export type CharacterId = z.infer<typeof characterSchema>;
export const characterNames: Record<CharacterId, string> = {
  whale: "DeepSeek",
  claude: "Claude",
  gemini: "Gemini",
  gpt: "GPT",
  corgi: "柯基",
};
