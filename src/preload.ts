import { contextBridge, ipcRenderer } from "electron";
import {
  assetErrorSchema,
  channels,
  presentationSchema,
  type PetBridge,
} from "./shared/contract";
const bridge: PetBridge = {
  async getPresentation() {
    return presentationSchema.parse(
      await ipcRenderer.invoke(channels.getPresentation),
    );
  },
  onPresentation(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const parsed = presentationSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(channels.presentation, receive);
    return () => ipcRenderer.removeListener(channels.presentation, receive);
  },
  reportAssetError(message) {
    ipcRenderer.send(channels.assetError, assetErrorSchema.parse(message));
  },
};
contextBridge.exposeInMainWorld("mosey", bridge);

// Temporary early main-world exception evidence: static import failures can
// precede Playwright's pageerror listener and the renderer module body.
contextBridge.executeInMainWorld({
  func: () => {
    console.info("DEBUG-pr18 early-listeners-installed", location.href);
    const timeline: unknown[] = [];
    Reflect.set(window, "__DEBUG_pr18_scriptTimeline", timeline);
    const record = (event: Event) => {
      const script =
        event.target instanceof HTMLScriptElement ? event.target : undefined;
      if (
        !script &&
        (event.type === "error" || event.type === "load") &&
        event.target !== window
      )
        return;
      const entry = {
        event: event.type,
        now: performance.now(),
        readyState: document.readyState,
        url: location.href,
        script: script
          ? {
              src: script.src,
              type: script.type,
              async: script.async,
              defer: script.defer,
              noModule: script.noModule,
              connected: script.isConnected,
            }
          : null,
      };
      if (timeline.length < 30) timeline.push(entry);
      console.info("DEBUG-pr18 script-timeline", JSON.stringify(entry));
    };
    document.addEventListener("load", record, true);
    document.addEventListener("error", record, true);
    document.addEventListener("DOMContentLoaded", record);
    document.addEventListener("readystatechange", record);
    window.addEventListener("load", record);
    window.addEventListener("error", (event) => {
      window.mosey.reportAssetError(
        `DEBUG-pr18 early-error ${event.message} ${event.filename}:${event.lineno}:${event.colno} ${String(event.error?.stack ?? "")}`.slice(
          0,
          500,
        ),
      );
    });
    window.addEventListener("unhandledrejection", (event) => {
      window.mosey.reportAssetError(
        `DEBUG-pr18 early-rejection ${String(event.reason?.stack ?? event.reason)}`.slice(
          0,
          500,
        ),
      );
    });
  },
});
