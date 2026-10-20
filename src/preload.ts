import { contextBridge, ipcRenderer } from "electron";
import {
  assetErrorSchema,
  inputSchema,
  channels,
  presentationSchema,
  type PetBridge,
} from "./shared/contract";
const bridge: PetBridge = {
  input(event) {
    ipcRenderer.send(channels.input, inputSchema.parse(event));
  },
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
