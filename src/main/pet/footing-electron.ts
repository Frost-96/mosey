import { screen, type BrowserWindow } from "electron";
import type { DockCapture } from "../platform/dock/capture";
import type { FootingAdapter } from "./footing";

// Production footing adapter: the pet window, the primary display's work area,
// the main process clock and the Dock capture. Footing stays free of Electron.
export function electronFootingAdapter(
  pet: BrowserWindow,
  dock: Pick<DockCapture, "stop">,
): FootingAdapter {
  return {
    now: () => performance.now(),
    schedule(delayMs, callback) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
    windowBounds: () => pet.getBounds(),
    setWindowPosition: (x, y) => pet.setPosition(x, y, false),
    workArea: () => screen.getPrimaryDisplay().workArea,
    stopObserving: () => dock.stop(),
  };
}
