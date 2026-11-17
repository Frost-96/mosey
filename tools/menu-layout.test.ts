import assert from "node:assert/strict";
import { test } from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import {
  petMenu,
  statusMenu,
  type MenuCommands,
  type MenuState,
} from "../src/main/menu-layout.ts";
import {
  dockStatusCode,
  dockStatuses,
  dockStatusLabel,
  type DockStatus,
} from "../src/main/platform/dock/status.ts";

// Menus are verified through their templates: the same item trees Electron
// installs as the application menu, pops up from the menu bar extra and from
// the pet body. Items are addressed by id; labels are checked only for language.
const commands: MenuCommands = {
  retryPet() {},
  setVisibility() {},
  changeSize() {},
  openSettings() {},
  retryDock() {},
  quit() {},
};
const diagnostics: MenuItemConstructorOptions = {
  id: "dock-validation",
  label: "诊断",
  submenu: [],
};
const state = (overrides: Partial<MenuState> = {}): MenuState => ({
  visibility: "visible",
  size: 160,
  failed: false,
  dock: "active",
  ...overrides,
});
const ids = (items: MenuItemConstructorOptions[]) =>
  items.map((item) => (item.type === "separator" ? "—" : item.id));
const find = (items: MenuItemConstructorOptions[], id: string) => {
  const item = items.find((item) => item.id === id);
  assert.ok(item, `missing ${id}`);
  return item;
};
const submenu = (item: MenuItemConstructorOptions) =>
  item.submenu as MenuItemConstructorOptions[];
const walk = (
  items: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] =>
  items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? walk(item.submenu) : []),
  ]);
const menus = (overrides: Partial<MenuState> = {}) => [
  statusMenu(state(overrides), commands, diagnostics, { accelerators: true }),
  statusMenu(state(overrides), commands, diagnostics, { accelerators: false }),
  petMenu(state(overrides), commands),
];
const everyState = [
  ...dockStatuses.map((dock) => state({ dock })),
  state({ failed: true }),
  state({ visibility: "hidden" }),
];

test("the status menu lists pet controls, settings, Dock interaction and quit", () => {
  for (const accelerators of [true, false])
    assert.deepEqual(
      ids(statusMenu(state(), commands, diagnostics, { accelerators })),
      [
        "hide-pet",
        "pet-size",
        "—",
        "open-settings",
        "dock-interaction",
        "—",
        "quit",
      ],
    );
  const size = find(
    statusMenu(state(), commands, diagnostics, { accelerators: false }),
    "pet-size",
  );
  assert.deepEqual(
    submenu(size).map(({ id, label, checked }) => ({ id, label, checked })),
    [
      { id: "pet-size-70", label: "小", checked: false },
      { id: "pet-size-160", label: "中", checked: true },
      { id: "pet-size-240", label: "大", checked: false },
    ],
  );
});

test("the status menu offers Retry Mosey only after the pet failed, and Show Mosey while hidden", () => {
  assert.deepEqual(
    ids(
      statusMenu(state({ failed: true }), commands, diagnostics, {
        accelerators: false,
      }),
    ).slice(0, 2),
    ["retry-pet", "hide-pet"],
  );
  const hidden = statusMenu(
    state({ visibility: "hidden" }),
    commands,
    diagnostics,
    { accelerators: false },
  );
  assert.equal(ids(hidden)[0], "show-pet");
  assert.equal(find(hidden, "show-pet").label, "显示 Mosey");
});

test("Dock interaction holds its status, Retry Dock interaction and the diagnostics", () => {
  const dock = find(
    statusMenu(state({ dock: "waiting" }), commands, diagnostics, {
      accelerators: false,
    }),
    "dock-interaction",
  );
  assert.equal(dock.label, "Dock 交互");
  assert.deepEqual(ids(submenu(dock)), [
    "dock-runtime-status",
    "dock-retry",
    "—",
    "dock-validation",
  ]);
  const status = find(submenu(dock), "dock-runtime-status");
  assert.equal(status.enabled, false);
  assert.equal(dockStatusCode(status.label!), "waiting");
});

test("only the application menu shows keyboard equivalents", () => {
  const accelerators = (accelerators: boolean) =>
    Object.fromEntries(
      walk(
        statusMenu(state(), commands, diagnostics, { accelerators }),
      ).flatMap((item) =>
        item.accelerator ? [[item.id, item.accelerator]] : [],
      ),
    );
  assert.deepEqual(accelerators(true), {
    "open-settings": "CommandOrControl+,",
    quit: "CommandOrControl+Q",
  });
  assert.deepEqual(accelerators(false), {});
  assert.deepEqual(
    walk(petMenu(state(), commands)).filter((item) => item.accelerator),
    [],
  );
});

test("a Dock that needs the user adds an unclickable warning on top; transient states stay quiet", () => {
  const needsUser: DockStatus[] = ["needs-permission", "retry-required"];
  for (const dock of dockStatuses) {
    const [tray, application] = [false, true].map((accelerators) =>
      statusMenu(state({ dock, failed: true }), commands, diagnostics, {
        accelerators,
      }),
    );
    for (const menu of [tray!, application!])
      if (needsUser.includes(dock)) {
        assert.deepEqual(ids(menu).slice(0, 3), [
          "dock-attention",
          "—",
          "retry-pet",
        ]);
        assert.equal(menu[0]!.label, "⚠ Dock 交互不可用");
        assert.equal(menu[0]!.enabled, false);
      } else assert.ok(!ids(menu).includes("dock-attention"), dock);
  }
});

test("the pet menu lists size, Hide Mosey, settings and quit", () => {
  for (const visibility of ["visible", "hidden"] as const)
    assert.deepEqual(ids(petMenu(state({ visibility }), commands)), [
      "pet-size",
      "hide-pet",
      "open-settings",
      "—",
      "quit",
    ]);
});

test("no menu offers launch at login", () => {
  for (const each of everyState)
    for (const menu of menus(each))
      for (const item of walk(menu)) {
        assert.ok(!item.id?.startsWith("login"), item.id);
        assert.ok(!item.label?.includes("开机启动"), item.label);
      }
});

test("menu text is Chinese apart from the names Mosey and Dock", () => {
  for (const each of everyState)
    for (const menu of menus(each))
      for (const { label } of walk(menu))
        if (label !== undefined)
          assert.doesNotMatch(
            label.replaceAll(/\b(?:Mosey|Dock)\b/g, ""),
            /[A-Za-z]/,
            label,
          );
});

test("every Dock status reads back as its own code", () => {
  for (const status of dockStatuses)
    assert.equal(dockStatusCode(dockStatusLabel(status)), status);
  assert.equal(dockStatusCode("Dock interaction active"), undefined);
});
