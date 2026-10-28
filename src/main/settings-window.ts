import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import {
  channels,
  characterSchema,
  emptyRequestSchema,
  loginLaunchRequestSchema,
  type Settings,
} from "../shared/contract";
import { petSizeSchema, type PetSize } from "../shared/size";

type Controls = {
  read(): Omit<Settings, "revision">;
  setCharacter(character: Settings["character"]): void;
  changeSize(size: PetSize, commit?: boolean): void;
  showPet(): void;
  setLoginLaunch(enabled: boolean): void;
  openLoginSettings(): Promise<void>;
  commitPreview(): void;
};

// One reusable window owns its IPC authorization and monotonically versioned
// snapshots. Actual pet preferences and system state remain with their owners.
export class SettingsWindow {
  private window: BrowserWindow | undefined;
  private revision = 0;

  constructor(private readonly controls: Controls) {
    ipcMain.handle(channels.setCharacter, (event, value: unknown) => {
      if (!this.authorized(event))
        throw new Error("Untrusted character request");
      controls.setCharacter(characterSchema.parse(value));
      return this.snapshot();
    });
    ipcMain.handle(channels.getSettings, (event, value: unknown) => {
      if (!this.authorized(event))
        throw new Error("Untrusted settings request");
      emptyRequestSchema.parse(value);
      return this.snapshot();
    });
    ipcMain.handle(channels.setSize, (event, value: unknown) => {
      if (!this.authorized(event)) throw new Error("Untrusted size request");
      controls.changeSize(petSizeSchema.parse(value));
      return this.snapshot();
    });
    ipcMain.handle(channels.setLoginLaunch, (event, value: unknown) => {
      if (!this.authorized(event))
        throw new Error("Untrusted login launch request");
      controls.setLoginLaunch(loginLaunchRequestSchema.parse(value));
      return this.snapshot();
    });
    ipcMain.handle(
      channels.openLoginSettings,
      async (event, value: unknown) => {
        if (!this.authorized(event))
          throw new Error("Untrusted system settings request");
        emptyRequestSchema.parse(value);
        await controls.openLoginSettings();
        return this.snapshot();
      },
    );
    ipcMain.handle(channels.previewSize, (event, value: unknown) => {
      if (!this.authorized(event)) throw new Error("Untrusted size preview");
      controls.changeSize(petSizeSchema.parse(value), false);
      return this.snapshot();
    });
    ipcMain.handle(channels.showPet, (event, value: unknown) => {
      if (!this.authorized(event))
        throw new Error("Untrusted visibility request");
      emptyRequestSchema.parse(value);
      controls.showPet();
      return this.snapshot();
    });
  }

  private authorized(event: IpcMainInvokeEvent) {
    return (
      this.window &&
      event.sender === this.window.webContents &&
      event.senderFrame === this.window.webContents.mainFrame
    );
  }

  private snapshot(): Settings {
    return { revision: ++this.revision, ...this.controls.read() };
  }

  publish = () =>
    this.window?.webContents.send(channels.settings, this.snapshot());

  open = () => {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      this.publish();
      return;
    }
    const window = new BrowserWindow({
      title: "Mosey 设置",
      width: 460,
      height: 680,
      resizable: false,
      show: false,
      webPreferences: {
        preload: path.join(import.meta.dirname, "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window = window;
    window.on("focus", this.publish);
    window.on("close", () => this.controls.commitPreview());
    window.on("closed", () => {
      if (this.window === window) this.window = undefined;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.once("ready-to-show", () => window.show());
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL)
      void window.loadURL(
        new URL("?settings", MAIN_WINDOW_VITE_DEV_SERVER_URL).href,
      );
    else
      void window.loadFile(
        path.join(
          import.meta.dirname,
          `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
        ),
        { query: { settings: "" } },
      );
  };
}
