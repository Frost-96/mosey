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
  looking: ["looking"],
  sitting: ["sittingdown", "sitting", "standingup"],
  yawning: ["yawning"],
  petted: ["petted"],
  grooming: ["grooming"],
  celebrating: ["celebrating"],
  habit: ["habit"],
} as const satisfies Record<string, readonly Atlas["action"][]>;
export type CharacterCapability = keyof typeof extensionRequirements;

export const dailyActionDefinitions = [
  { action: "looking", label: "张望", capability: "looking" },
  { action: "sitting", label: "坐下休息", capability: "sitting" },
  { action: "standingup", label: "站起来", capability: "sitting" },
  { action: "yawning", label: "打哈欠", capability: "yawning" },
  { action: "petted", label: "摸摸头", capability: "petted" },
  { action: "grooming", label: "整理仪容", capability: "grooming" },
  { action: "celebrating", label: "庆祝", capability: "celebrating" },
  { action: "habit", label: "小习惯", capability: "habit" },
] as const satisfies readonly {
  action: Atlas["action"];
  label: string;
  capability: CharacterCapability;
}[];
export type DailyAction = (typeof dailyActionDefinitions)[number]["action"];

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
