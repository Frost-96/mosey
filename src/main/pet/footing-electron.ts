import { screen, type BrowserWindow } from "electron";
import type { FootingAdapter } from "./footing";

// Production footing adapter: the pet window, the primary display's work area
// and the main process clock. Footing itself stays free of Electron.
export function electronFootingAdapter(pet: BrowserWindow): FootingAdapter {
  return {
    now: () => performance.now(),
    schedule(delayMs, callback) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
    windowBounds: () => pet.getBounds(),
    setWindowPosition: (x, y) => pet.setPosition(x, y, false),
    workArea: () => screen.getPrimaryDisplay().workArea,
  };
}
