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
    console.info("DEBUG-pr18 early-listeners-installed");
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
