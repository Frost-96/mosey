import path from "node:path";
import { powerMonitor, type BrowserWindow } from "electron";
import log from "electron-log/main";
import type { PreferencesStore } from "../platform/preferences";
import type { PresenceAdapter } from "./presence";

// Production presence adapter: the pet window's native visibility, the stored
// display intent, renderer loads and the system events that move them. System
// sleep and wake report sleep; a locked and unlocked screen report the lock.
// Presence keeps the two apart, so waking behind a locked screen leaves the pet
// suspended until it unlocks. A finished page load and an exited renderer
// process report the renderer lifecycle; presence decides what they mean.
// Presence stays free of Electron and only reads the intent.
//
// A missed "unlock-screen" leaves the pet suspended until the next unlock; the
// next lock and unlock clear it. The adapter does not correct the lock from
// powerMonitor.getSystemIdleState: on macOS Chromium answers "locked" from the
// same screen lock notifications that drive these events, never from a direct
// query, so it misses whatever they miss, and it also answers "locked" while a
// screen saver runs, which no unlock would ever clear.
export function electronPresenceAdapter(
  pet: BrowserWindow,
  preferences: Pick<PreferencesStore, "visibility">,
  // The development server entry; packaged builds load the bundled page.
  devURL: string | undefined,
): PresenceAdapter {
  return {
    nativelyVisible: () => pet.isVisible(),
    show: () => pet.showInactive(),
    hide: () => pet.hide(),
    intent: () => preferences.visibility,
    load: () =>
      devURL
        ? pet.loadURL(devURL)
        : pet.loadFile(
            path.join(
              import.meta.dirname,
              `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
            ),
          ),
    destroyed: () => pet.isDestroyed(),
    listen({
      sleep,
      wake,
      lock,
      unlock,
      visibilityChanged,
      rendererLoaded,
      rendererGone,
    }) {
      // The contents may already be destroyed when the window reports closed.
      const contents = pet.webContents;
      const gone = (
        _event: Electron.Event,
        details: Electron.RenderProcessGoneDetails,
      ) => {
        log.error("Pet renderer exited", details.reason, details.exitCode);
        rendererGone();
      };
      powerMonitor.on("suspend", sleep);
      powerMonitor.on("resume", wake);
      powerMonitor.on("lock-screen", lock);
      powerMonitor.on("unlock-screen", unlock);
      pet.on("show", visibilityChanged);
      pet.on("hide", visibilityChanged);
      contents.on("did-finish-load", rendererLoaded);
      contents.on("render-process-gone", gone);
      pet.once("closed", () => {
        powerMonitor.off("suspend", sleep);
        powerMonitor.off("resume", wake);
        powerMonitor.off("lock-screen", lock);
        powerMonitor.off("unlock-screen", unlock);
        pet.off("show", visibilityChanged);
        pet.off("hide", visibilityChanged);
        contents.off("did-finish-load", rendererLoaded);
        contents.off("render-process-gone", gone);
      });
    },
  };
}
