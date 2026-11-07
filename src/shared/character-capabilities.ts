import type { Atlas } from "./assets.ts";

export const baseActions = [
  "resting",
  "walking",
  "dragging",
  "falling",
  "landing",
] as const;

// A behavior is available only when its whole path has authored poses. These
// dependencies are shared by validation, behavior selection and future import UI.
export const extensionRequirements = {
  sleep: ["settling", "sleeping", "ear", "waking"],
  stretching: ["stretching"],
  playing: ["playing"],
  tilt: ["tilt"],
  paw: ["paw"],
  belly: ["belly"],
  flutter: ["flutter", "falling", "landing"],
  climbing: ["climbing", "landing"],
} as const satisfies Record<string, readonly Atlas["action"][]>;
export type CharacterCapability = keyof typeof extensionRequirements;

export function characterCapabilities(
  actions: readonly Atlas["action"][],
): CharacterCapability[] {
  return (Object.keys(extensionRequirements) as CharacterCapability[]).filter(
    (capability) =>
      extensionRequirements[capability].every((action) =>
        actions.includes(action),
      ),
  );
}
