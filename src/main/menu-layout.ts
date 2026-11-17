import type { MenuItemConstructorOptions as Item } from "electron";
import type { PetSize } from "../shared/size.ts";
import { menuIds, sizeMenuId } from "./menu-ids.ts";
import {
  dockNeedsAttention,
  dockStatusLabel,
  type DockStatus,
} from "./platform/dock/status.ts";

// Menu templates, free of Electron so their layout is verified without a
// desktop. The menu bar extra and the application menu share one layout; only
// the application menu advertises keyboard equivalents. Launch at login is a
// settings window control and appears in no menu.
export type MenuState = {
  visibility: "visible" | "hidden";
  size: PetSize;
  failed: boolean;
  dock: DockStatus;
};

export type MenuCommands = {
  retryPet(): void;
  setVisibility(next: "visible" | "hidden"): void;
  changeSize(size: PetSize): void;
  openSettings(): void;
  retryDock(): void;
  quit(): void;
};

const separator: Item = { type: "separator" };

const sizeItem = (state: MenuState, commands: MenuCommands): Item => ({
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
    checked: state.size === size,
    click: () => commands.changeSize(size),
  })),
});

const settingsItem = (commands: MenuCommands, accelerators: boolean): Item => ({
  id: menuIds.settings,
  label: "设置…",
  ...(accelerators ? { accelerator: "CommandOrControl+," } : {}),
  click: () => commands.openSettings(),
});

const quitItem = (commands: MenuCommands, accelerators: boolean): Item => ({
  id: menuIds.quit,
  label: "退出 Mosey",
  ...(accelerators ? { accelerator: "CommandOrControl+Q" } : {}),
  click: () => commands.quit(),
});

export function statusMenu(
  state: MenuState,
  commands: MenuCommands,
  diagnostics: Item,
  { accelerators }: { accelerators: boolean },
): Item[] {
  const visible = state.visibility === "visible";
  return [
    ...(dockNeedsAttention(state.dock)
      ? [
          {
            id: menuIds.dockAttention,
            label: "⚠ Dock 交互不可用",
            enabled: false,
          },
          separator,
        ]
      : []),
    ...(state.failed
      ? [
          {
            id: menuIds.retryPet,
            label: "重试 Mosey",
            click: () => commands.retryPet(),
          },
        ]
      : []),
    {
      id: visible ? menuIds.hidePet : menuIds.showPet,
      label: visible ? "隐藏 Mosey" : "显示 Mosey",
      click: () => commands.setVisibility(visible ? "hidden" : "visible"),
    },
    sizeItem(state, commands),
    separator,
    settingsItem(commands, accelerators),
    {
      id: menuIds.dockSection,
      label: "Dock 交互",
      submenu: [
        {
          id: menuIds.dockStatus,
          label: dockStatusLabel(state.dock),
          enabled: false,
        },
        {
          id: menuIds.dockRetry,
          label: "重试 Dock 交互",
          click: () => commands.retryDock(),
        },
        separator,
        diagnostics,
      ],
    },
    separator,
    quitItem(commands, accelerators),
  ];
}

// The pet session puts the 动作 submenu above these items.
export function petMenu(state: MenuState, commands: MenuCommands): Item[] {
  return [
    sizeItem(state, commands),
    {
      id: menuIds.hidePet,
      label: "隐藏 Mosey",
      click: () => commands.setVisibility("hidden"),
    },
    settingsItem(commands, false),
    separator,
    quitItem(commands, false),
  ];
}
