import { app, Menu, Tray } from "electron";
import type { Settings } from "../shared/contract";
import type { PetSize } from "../shared/size";
import type { SettingsWindow } from "./settings-window";
import type { DockCapture } from "./platform/dock/capture";
import { dockNeedsAttention, dockStatusLabel } from "./platform/dock/status";
import { menuIds, sizeMenuId } from "./menu-ids";
import { pawTemplateImage } from "./tray-icon";

type PetMenu = {
  state(): Pick<Settings, "size" | "visibility"> & { failed: boolean };
  setVisibility(next: "visible" | "hidden"): void;
  changeSize(size: PetSize): void;
  retry(): Promise<void>;
};

type Item = Electron.MenuItemConstructorOptions;
const separator: Item = { type: "separator" };

// Read current state on every native menu opening and rebuild after reentry.
export class ApplicationMenus {
  constructor(
    private readonly pet: PetMenu,
    private readonly settings: SettingsWindow,
    private readonly dock: DockCapture,
  ) {
    const tray = new Tray(pawTemplateImage());
    app.on("will-quit", () => tray.destroy());
    tray.setToolTip("Mosey");
    // macOS's cached native context menu does not provide a reliable pre-open
    // callback. Open explicitly so every click reads the current system setting.
    const openTrayMenu = () => tray.popUpContextMenu(this.refresh());
    tray.on("click", openTrayMenu);
    tray.on("right-click", openTrayMenu);
  }
  private settingsItem = (accelerator: boolean): Item => ({
    id: menuIds.settings,
    label: "设置…",
    ...(accelerator ? { accelerator: "CommandOrControl+," } : {}),
    click: this.settings.open,
  });
  private visibilityItem = (): Item => {
    const visible = this.pet.state().visibility === "visible";
    return {
      id: visible ? menuIds.hidePet : menuIds.showPet,
      label: visible ? "隐藏 Mosey" : "显示 Mosey",
      click: () => this.pet.setVisibility(visible ? "hidden" : "visible"),
    };
  };
  private hideItem = (): Item => ({
    id: menuIds.hidePet,
    label: "隐藏 Mosey",
    click: () => this.pet.setVisibility("hidden"),
  });
  private quitItem = (accelerator: boolean): Item => ({
    id: menuIds.quit,
    label: "退出 Mosey",
    ...(accelerator ? { accelerator: "CommandOrControl+Q" } : {}),
    click: () => app.quit(),
  });
  private attentionItems = (): Item[] =>
    dockNeedsAttention(this.dock.status)
      ? [
          {
            id: menuIds.dockAttention,
            label: "⚠ Dock 交互不可用",
            enabled: false,
          },
          separator,
        ]
      : [];
  private dockSection = (): Item => ({
    id: menuIds.dockSection,
    label: "Dock 交互",
    submenu: [
      {
        id: menuIds.dockStatus,
        label: dockStatusLabel(this.dock.status),
        enabled: false,
      },
      {
        id: menuIds.dockRetry,
        label: "重试 Dock 交互",
        click: this.dock.retry,
      },
      separator,
      this.dock.menu(),
    ],
  });
  private recoveryItems = (): Item[] =>
    this.pet.state().failed
      ? [
          {
            id: menuIds.retryPet,
            label: "重试 Mosey",
            click: () => void this.pet.retry(),
          },
        ]
      : [];
  private sizeItem = (): Item => ({
    id: menuIds.size,
    label: "大小",
    submenu: (
      [
        ["小", 70],
        ["中", 160],
        ["大", 240],
      ] as const
    ).map(([label, size]) => ({
      id: sizeMenuId(size),
      label,
      type: "checkbox",
      checked: this.pet.state().size === size,
      click: () => this.pet.changeSize(size),
    })),
  });
  // One layout for the menu bar extra and the application menu; only the
  // application menu advertises keyboard equivalents.
  private mainItems = (accelerators: boolean): Item[] => [
    ...this.attentionItems(),
    ...this.recoveryItems(),
    this.visibilityItem(),
    this.sizeItem(),
    separator,
    this.settingsItem(accelerators),
    this.dockSection(),
    separator,
    this.quitItem(accelerators),
  ];
  private menuRevision = 0;
  refresh = (): Menu => {
    for (;;) {
      const revision = ++this.menuRevision;
      const applicationMenu = Menu.buildFromTemplate([
        {
          id: menuIds.application,
          label: "Mosey",
          submenu: this.mainItems(true),
        },
      ]);
      const trayMenu = Menu.buildFromTemplate(this.mainItems(false));
      // Native menu construction and installation can admit newer commands.
      // Rebuild from the latest choices if a nested refresh superseded this one;
      // neither the application menu nor the returned tray menu may go stale.
      if (revision !== this.menuRevision) continue;
      Menu.setApplicationMenu(applicationMenu);
      if (revision !== this.menuRevision) continue;
      return trayMenu;
    }
  };

  // The session prepends the 动作 submenu to these items.
  bodyTemplate(): Item[] {
    return [
      this.sizeItem(),
      this.hideItem(),
      this.settingsItem(false),
      separator,
      this.quitItem(false),
    ];
  }
}
