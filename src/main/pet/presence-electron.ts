import path from "node:path";
import { powerMonitor, type BrowserWindow } from "electron";
import log from "electron-log/main";
import type { PreferencesStore } from "../platform/preferences";
import type { PresenceAdapter } from "./presence";

// Production presence adapter: the pet window's native visibility, the stored
// display intent, renderer loads and the system events that move them. Sleep
// and a locked screen both suspend; waking and unlocking both resume. A
// finished page load and an exited renderer process report the renderer
// lifecycle; presence decides what they mean. Presence stays free of Electron
// and only reads the intent.
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
      suspend,
      resume,
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
      powerMonitor.on("suspend", suspend);
      powerMonitor.on("lock-screen", suspend);
      powerMonitor.on("resume", resume);
      powerMonitor.on("unlock-screen", resume);
      pet.on("show", visibilityChanged);
      pet.on("hide", visibilityChanged);
      contents.on("did-finish-load", rendererLoaded);
      contents.on("render-process-gone", gone);
      pet.once("closed", () => {
        powerMonitor.off("suspend", suspend);
        powerMonitor.off("lock-screen", suspend);
        powerMonitor.off("resume", resume);
        powerMonitor.off("unlock-screen", resume);
        pet.off("show", visibilityChanged);
        pet.off("hide", visibilityChanged);
        contents.off("did-finish-load", rendererLoaded);
        contents.off("render-process-gone", gone);
      });
    },
  };
}
