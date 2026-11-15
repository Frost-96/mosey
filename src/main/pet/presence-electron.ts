import { powerMonitor, type BrowserWindow } from "electron";
import type { PreferencesStore } from "../platform/preferences";
import type { PresenceAdapter } from "./presence";

// Production presence adapter: the pet window's native visibility, the stored
// display intent and the system events that move them. Sleep and a locked
// screen both suspend; waking and unlocking both resume. Presence stays free
// of Electron and only reads the intent.
export function electronPresenceAdapter(
  pet: BrowserWindow,
  preferences: Pick<PreferencesStore, "visibility">,
): PresenceAdapter {
  return {
    nativelyVisible: () => pet.isVisible(),
    show: () => pet.showInactive(),
    hide: () => pet.hide(),
    intent: () => preferences.visibility,
    listen({ suspend, resume, visibilityChanged }) {
      powerMonitor.on("suspend", suspend);
      powerMonitor.on("lock-screen", suspend);
      powerMonitor.on("resume", resume);
      powerMonitor.on("unlock-screen", resume);
      pet.on("show", visibilityChanged);
      pet.on("hide", visibilityChanged);
      pet.once("closed", () => {
        powerMonitor.off("suspend", suspend);
        powerMonitor.off("lock-screen", suspend);
        powerMonitor.off("resume", resume);
        powerMonitor.off("unlock-screen", resume);
        pet.off("show", visibilityChanged);
        pet.off("hide", visibilityChanged);
      });
    },
  };
}
