import type { BrowserWindow } from "electron";
import type { PresenceAdapter } from "./presence";

// Production presence adapter: the pet window's native visibility. Presence
// stays free of Electron.
export function electronPresenceAdapter(pet: BrowserWindow): PresenceAdapter {
  return {
    nativelyVisible: () => pet.isVisible(),
  };
}
