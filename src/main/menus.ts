import { app, Menu, Tray } from "electron";
import type { Settings } from "../shared/contract";
import type { PetSize } from "../shared/size";
import type { SettingsWindow } from "./settings-window";
import type { DockCapture } from "./platform/dock/capture";
import { menuIds } from "./menu-ids";
import {
  petMenu,
  statusMenu,
  type MenuCommands,
  type MenuState,
} from "./menu-layout";
import { pawTemplateImage } from "./tray-icon";

type PetMenu = {
  state(): Pick<Settings, "size" | "visibility"> & {
    petRendererFailed: boolean;
  };
  setVisibility(next: "visible" | "hidden"): void;
  changeSize(size: PetSize): void;
  retry(): Promise<void>;
};

// Read current state on every native menu opening and rebuild after reentry.
export class ApplicationMenus {
  private readonly commands: MenuCommands;

  constructor(
    private readonly pet: PetMenu,
    settings: SettingsWindow,
    private readonly dock: DockCapture,
  ) {
    this.commands = {
      retryPet: () => void pet.retry(),
      setVisibility: (next) => pet.setVisibility(next),
      changeSize: (size) => pet.changeSize(size),
      openSettings: () => settings.open(),
      retryDock: () => dock.retry(),
      quit: () => app.quit(),
    };
    const tray = new Tray(pawTemplateImage());
    app.on("will-quit", () => tray.destroy());
    tray.setToolTip("Mosey");
    // macOS's cached native context menu does not provide a reliable pre-open
    // callback. Open explicitly so every click reads the current state.
    const openTrayMenu = () => tray.popUpContextMenu(this.refresh());
    tray.on("click", openTrayMenu);
    tray.on("right-click", openTrayMenu);
  }

  private state = (): MenuState => ({
    ...this.pet.state(),
    dock: this.dock.status,
  });

  private menuRevision = 0;
  refresh = (): Menu => {
    for (;;) {
      const revision = ++this.menuRevision;
      const state = this.state();
      const applicationMenu = Menu.buildFromTemplate([
        {
          id: menuIds.application,
          label: "Mosey",
          submenu: statusMenu(state, this.commands, this.dock.menu(), {
            accelerators: true,
          }),
        },
      ]);
      const trayMenu = Menu.buildFromTemplate(
        statusMenu(state, this.commands, this.dock.menu(), {
          accelerators: false,
        }),
      );
      // Native menu construction and installation can admit newer commands.
      // Rebuild from the latest choices if a nested refresh superseded this one;
      // neither the application menu nor the returned tray menu may go stale.
      if (revision !== this.menuRevision) continue;
      Menu.setApplicationMenu(applicationMenu);
      if (revision !== this.menuRevision) continue;
      return trayMenu;
    }
  };

  bodyTemplate(): Electron.MenuItemConstructorOptions[] {
    return petMenu(this.state(), this.commands);
  }
}
