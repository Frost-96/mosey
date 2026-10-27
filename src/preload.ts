import { contextBridge, ipcRenderer } from "electron";
import {
  assetErrorSchema,
  characterSchema,
  characterPreparationSchema,
  characterPreparedSchema,
  inputSchema,
  gestureCancellationSchema,
  channels,
  presentationSchema,
  type PetBridge,
  settingsSchema,
  loginLaunchRequestSchema,
  type SettingsBridge,
} from "./shared/contract";
const bridge: PetBridge = {
  onPrepareCharacter(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const parsed = characterPreparationSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(channels.prepareCharacter, receive);
    return () => ipcRenderer.removeListener(channels.prepareCharacter, receive);
  },
  characterPrepared(result) {
    ipcRenderer.send(
      channels.characterPrepared,
      characterPreparedSchema.parse(result),
    );
  },
  assetsReady() {
    ipcRenderer.send(channels.assetsReady);
  },
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
  onGestureCancellation(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const parsed = gestureCancellationSchema.safeParse(value);
      if (parsed.success) listener(parsed.data.gestureId);
    };
    ipcRenderer.on(channels.gestureCancellation, receive);
    return () =>
      ipcRenderer.removeListener(channels.gestureCancellation, receive);
  },
  reportAssetError(message) {
    ipcRenderer.send(channels.assetError, assetErrorSchema.parse(message));
  },
};
contextBridge.exposeInMainWorld("mosey", bridge);

const settingsBridge: SettingsBridge = {
  async setCharacter(character) {
    return settingsSchema.parse(
      await ipcRenderer.invoke(
        channels.setCharacter,
        characterSchema.parse(character),
      ),
    );
  },
  async get() {
    return settingsSchema.parse(await ipcRenderer.invoke(channels.getSettings));
  },
  async setSize(size) {
    return settingsSchema.parse(
      await ipcRenderer.invoke(channels.setSize, size),
    );
  },
  async previewSize(size) {
    return settingsSchema.parse(
      await ipcRenderer.invoke(channels.previewSize, size),
    );
  },
  async showPet() {
    return settingsSchema.parse(await ipcRenderer.invoke(channels.showPet));
  },
  async setLoginLaunch(enabled) {
    return settingsSchema.parse(
      await ipcRenderer.invoke(
        channels.setLoginLaunch,
        loginLaunchRequestSchema.parse(enabled),
      ),
    );
  },
  async openLoginSettings() {
    return settingsSchema.parse(
      await ipcRenderer.invoke(channels.openLoginSettings),
    );
  },
  onChange(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const parsed = settingsSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(channels.settings, receive);
    return () => ipcRenderer.removeListener(channels.settings, receive);
  },
};
contextBridge.exposeInMainWorld("moseySettings", settingsBridge);
