import { atlasSchema, type Atlas } from "./assets";
import { z } from "zod";
import { petSizeSchema } from "./size";
import idle from "../assets/generated/idle-atlas.json";
import climbing from "../assets/generated/climbing-atlas.json";
import sleeping from "../assets/generated/sleeping-atlas.json";
import settling from "../assets/generated/settling-atlas.json";
import waking from "../assets/generated/waking-atlas.json";
import ear from "../assets/generated/ear-atlas.json";
import walking from "../assets/generated/walking-atlas.json";
import stretching from "../assets/generated/stretching-atlas.json";
import playing from "../assets/generated/playing-atlas.json";
import tilt from "../assets/generated/tilt-atlas.json";
import paw from "../assets/generated/paw-atlas.json";
import belly from "../assets/generated/belly-atlas.json";
import dragging from "../assets/generated/dragging-atlas.json";
import flutter from "../assets/generated/flutter-atlas.json";
import falling from "../assets/generated/falling-atlas.json";
import landing from "../assets/generated/landing-atlas.json";
import whaleIdle from "../assets/generated/whale/idle-atlas.json";
import whaleWalking from "../assets/generated/whale/walking-atlas.json";
import whaleMotion from "../assets/characters/whale/motion.json";

const walkingMotionSchema = z.strictObject({
  cycleDistancePixels: z.number().positive(),
  cyclesPerWalk: z.number().int().positive(),
  pixelRatio: z.number().positive(),
  referenceWindowSize: petSizeSchema,
});

export type CharacterId = "corgi" | "whale";

// One internal entry point supplies both drawing and transparent hit geometry.
// Whale is intentionally incomplete: no fallback silently supplies missing poses.
const metadata = {
  corgi: [
    idle,
    climbing,
    sleeping,
    settling,
    waking,
    ear,
    walking,
    stretching,
    playing,
    tilt,
    paw,
    belly,
    dragging,
    flutter,
    falling,
    landing,
  ],
  whale: [whaleIdle, whaleWalking],
};
export function characterAssets(character: CharacterId): Atlas[] {
  return metadata[character].map((value) => atlasSchema.parse(value));
}
export function characterDirectory(character: CharacterId): string {
  return character === "corgi" ? "" : "whale/";
}

export function characterWalk(character: CharacterId) {
  if (character === "corgi") return undefined;
  const motion = walkingMotionSchema.parse(whaleMotion);
  const atlas = atlasSchema.parse(whaleWalking);
  return {
    durationMs:
      atlas.frames.reduce((total, frame) => total + frame.durationMs, 0) *
      motion.cyclesPerWalk,
    distance:
      (motion.cycleDistancePixels / motion.pixelRatio) * motion.cyclesPerWalk,
    referenceWindowSize: motion.referenceWindowSize,
  };
}
