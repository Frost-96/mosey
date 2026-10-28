import { app, Menu, Tray, nativeImage } from "electron";
import type { Settings } from "../shared/contract";
import type { PetSize } from "../shared/size";
import type { SettingsWindow } from "./settings-window";
import type { LoginLaunch } from "./platform/login-launch";
import type { DockCapture } from "./platform/dock/capture";

type PetMenu = {
  state(): Pick<Settings, "size" | "visibility"> & { failed: boolean };
  setVisibility(next: "visible" | "hidden"): void;
  changeSize(size: PetSize): void;
  retry(): Promise<void>;
};

// Read current state on every native menu opening and rebuild after reentry.
export class ApplicationMenus {
  constructor(
    private readonly pet: PetMenu,
    private readonly settings: SettingsWindow,
    private readonly loginLaunch: LoginLaunch,
    private readonly dock: DockCapture,
  ) {
    const icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    );
    const tray = new Tray(icon);
    app.on("will-quit", () => tray.destroy());
    tray.setTitle("🐾");
    tray.setToolTip("Mosey");
    // macOS's cached native context menu does not provide a reliable pre-open
    // callback. Open explicitly so every click reads the current system setting.
    const openTrayMenu = () => tray.popUpContextMenu(this.refresh());
    tray.on("click", openTrayMenu);
    tray.on("right-click", openTrayMenu);
  }
  private settingsItem = (): Electron.MenuItemConstructorOptions => ({
    label: "设置…",
    accelerator: "CommandOrControl+,",
    click: this.settings.open,
  });
  private visibilityItem = (): Electron.MenuItemConstructorOptions => ({
    label:
      this.pet.state().visibility === "visible" ? "Hide Mosey" : "Show Mosey",
    click: () =>
      this.pet.setVisibility(
        this.pet.state().visibility === "visible" ? "hidden" : "visible",
      ),
  });
  private dockItems = (): Electron.MenuItemConstructorOptions[] => [
    { id: "dock-runtime-status", label: this.dock.status, enabled: false },
    { label: "Retry Dock interaction", click: this.dock.retry },
  ];
  private recoveryItems = (): Electron.MenuItemConstructorOptions[] =>
    this.pet.state().failed
      ? [{ label: "Retry Mosey", click: () => void this.pet.retry() }]
      : [];
  private sizeItem = (): Electron.MenuItemConstructorOptions => ({
    label: "Pet Size",
    submenu: (
      [
        ["Small", 70],
        ["Medium", 160],
        ["Large", 240],
      ] as const
    ).map(([label, size]) => ({
      label,
      type: "checkbox",
      checked: this.pet.state().size === size,
      click: () => this.pet.changeSize(size),
    })),
  });
  private loginItems = (): Electron.MenuItemConstructorOptions[] => {
    const login = this.loginLaunch.read();
    return [
      {
        label: "Launch at Login",
        type: "checkbox",
        checked: login.status === "enabled",
        enabled: login.status === "enabled" || login.status === "disabled",
        click: (item) => {
          this.loginLaunch.setEnabled(item.checked);
          this.refresh();
          this.settings.publish();
        },
      },
      ...(login.status === "requires-approval"
        ? [
            { label: "开机启动等待系统批准", enabled: false },
            {
              label: "打开系统设置…",
              click: () => void this.openLoginSettings(),
            },
            {
              label: "取消待批准请求",
              click: () => {
                this.loginLaunch.setEnabled(false);
                this.refresh();
                this.settings.publish();
              },
            },
          ]
        : []),
      ...(login.status === "unavailable"
        ? [{ label: login.reason, enabled: false }]
        : []),
      ...(login.error ? [{ label: login.error, enabled: false }] : []),
    ];
  };
  private menuRevision = 0;
  refresh = (): Menu => {
    for (;;) {
      const revision = ++this.menuRevision;
      const diagnostic = this.dock.menu();
      const applicationMenu = Menu.buildFromTemplate([
        {
          label: "Mosey",
          submenu: [
            ...this.recoveryItems(),
            this.visibilityItem(),
            this.sizeItem(),
            ...this.loginItems(),
            this.settingsItem(),
            ...this.dockItems(),
            {
              label: "Quit Mosey",
              accelerator: "CommandOrControl+Q",
              click: () => app.quit(),
            },
          ],
        },
        diagnostic,
      ]);
      const trayMenu = Menu.buildFromTemplate([
        ...this.recoveryItems(),
        this.visibilityItem(),
        this.sizeItem(),
        ...this.loginItems(),
        this.settingsItem(),
        ...this.dockItems(),
        diagnostic,
        { label: "Quit Mosey", click: () => app.quit() },
      ]);
      // Native menu construction and installation can admit newer commands.
      // Rebuild from the latest choices if a nested refresh superseded this one;
      // neither the application menu nor the returned tray menu may go stale.
      if (revision !== this.menuRevision) continue;
      Menu.setApplicationMenu(applicationMenu);
      if (revision !== this.menuRevision) continue;
      return trayMenu;
    }
  };
  private async openLoginSettings() {
    await this.loginLaunch.openSettings();
    this.settings.publish();
    this.refresh();
  }

  bodyTemplate(): Electron.MenuItemConstructorOptions[] {
    return [
      { label: "Hide Mosey", click: () => this.pet.setVisibility("hidden") },
      this.sizeItem(),
      ...this.loginItems(),
      { label: "Quit Mosey", click: () => app.quit() },
    ];
  }
}
