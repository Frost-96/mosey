import { z } from "zod";
import { petSizeSchema } from "./size";
import {
  characterSchema,
  characterIdentitySchema,
  characterResourceSchema,
} from "./character-catalog";
import { preparedCharacterSchema, type PreparedCharacter } from "./characters";
export { characterSchema } from "./character-catalog";
export const presentationSchema = z.strictObject({
  ...characterResourceSchema.shape,
  size: petSizeSchema,
  geometryRevision: z.number().int().nonnegative(),
  posture: z.enum([
    "resting",
    "sleeping",
    "ear",
    "waking",
    "settling",
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
    "climbing",
  ]),
  direction: z.enum(["left", "right"]),
  actionId: z.number().int().nonnegative(),
  startedAt: z.number().nonnegative(),
  visibility: z.enum(["visible", "hidden"]),
  frozenAt: z.number().nonnegative().optional(),
});
export const inputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("context"),
    geometryRevision: z.number().int().nonnegative(),
    x: z.number().finite(),
    y: z.number().finite(),
    actionId: z.number().int().nonnegative(),
  }),
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
export const gestureCancellationSchema = z.strictObject({
  gestureId: z.number().int().nonnegative(),
});
export type PetInput = z.infer<typeof inputSchema>;
export const assetErrorSchema = z.string().min(1).max(500);
export const emptyRequestSchema = z.undefined();
export type Presentation = z.infer<typeof presentationSchema>;
export const characterPreparationSchema = z.strictObject({
  request: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  ...characterResourceSchema.shape,
  assets: preparedCharacterSchema,
});
export const characterPreparedSchema = characterPreparationSchema
  .omit({ assets: true })
  .extend({
    success: z.boolean(),
  });
export const retainedCharacterSchema = characterPreparedSchema.omit({
  success: true,
});
export type CharacterPreparation = z.infer<typeof characterPreparationSchema>;
export interface PetBridge {
  getCharacter(): Promise<PreparedCharacter>;
  onRetainCharacter(
    listener: (value: z.infer<typeof retainedCharacterSchema>) => void,
  ): () => void;
  onPrepareCharacter(
    listener: (request: CharacterPreparation) => void,
  ): () => void;
  characterPrepared(result: z.infer<typeof characterPreparedSchema>): void;
  assetsReady(): void;
  getPresentation(): Promise<Presentation>;
  onPresentation(listener: (presentation: Presentation) => void): () => void;
  onGestureCancellation(listener: (gestureId: number) => void): () => void;
  reportAssetError(message: string): void;
  input(event: PetInput): void;
}
export const channels = {
  getCharacter: "pet:get-character",
  retainCharacter: "pet:retain-character",
  prepareCharacter: "pet:prepare-character",
  characterPrepared: "pet:character-prepared",
  assetsReady: "pet:assets-ready",
  setCharacter: "settings:character",
  getSettings: "settings:get",
  setSize: "settings:size",
  setLoginLaunch: "settings:login-launch",
  openLoginSettings: "settings:open-login-settings",
  previewSize: "settings:preview-size",
  showPet: "settings:show-pet",
  settings: "settings:state",
  getPresentation: "pet:get-presentation",
  presentation: "pet:presentation",
  gestureCancellation: "pet:gesture-cancellation",
  assetError: "pet:asset-error",
  input: "pet:input",
} as const;
declare global {
  interface Window {
    mosey: PetBridge;
  }
}

export const loginLaunchSchema = z.strictObject({
  status: z.enum(["enabled", "disabled", "requires-approval", "unavailable"]),
  reason: z.string().optional(),
  error: z.string().optional(),
});
export const loginLaunchRequestSchema = z.boolean();
export const settingsSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  character: characterSchema,
  characters: z.array(characterIdentitySchema),
  pendingCharacter: z
    .strictObject({
      target: characterSchema,
      phase: z.enum(["loading", "waiting"]),
    })
    .optional(),
  failedCharacter: z
    .strictObject({
      target: characterSchema,
      reason: z.enum(["load", "save", "recovery"]),
      detail: z.string().max(500).optional(),
    })
    .optional(),
  size: petSizeSchema,
  visibility: z.enum(["visible", "hidden"]),
  failedSize: petSizeSchema.optional(),
  login: loginLaunchSchema,
});
export type Settings = z.infer<typeof settingsSchema>;
export interface SettingsBridge {
  setCharacter(character: z.infer<typeof characterSchema>): Promise<Settings>;
  get(): Promise<Settings>;
  setSize(size: number): Promise<Settings>;
  previewSize(size: number): Promise<Settings>;
  showPet(): Promise<Settings>;
  setLoginLaunch(enabled: boolean): Promise<Settings>;
  openLoginSettings(): Promise<Settings>;
  onChange(listener: (state: Settings) => void): () => void;
}
declare global {
  interface Window {
    moseySettings: SettingsBridge;
  }
}
