import { evidencePath } from "./support/evidence";
import { test, expect } from "vitest";
import type { ElectronApplication } from "playwright";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { menuIds } from "../src/main/menu-ids";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
const scaleFactor = process.env.MOSEY_TEST_SCALE_FACTOR ?? "1";

test.each([
  ["build", menuIds.showPet],
  ["build", menuIds.hidePet],
  ["install", menuIds.showPet],
  ["install", menuIds.hidePet],
] as const)(
  "menu %s preserves the newer %s choice",
  async (boundary, command) => {
    const visible = command === menuIds.showPet;
    // The controlled interleaving concerns menu updates. Native capture and its
    // menu status are exercised by the Dock acceptance suite.
    const session = await createPetTestSession({
      dock: "empty",
      preferences: {
        version: 3,
        character: "corgi",
        visibility: visible ? "hidden" : "visible",
        size: 160,
      },
    });
    let app: ElectronApplication | undefined;
    let restore: (() => Promise<void>) | undefined;
    try {
      const launched = await session.launch();
      app = launched.app;
      const pet = launched.pet;
      expect(await pet.evaluate(() => devicePixelRatio)).toBe(
        Number(scaleFactor),
      );
      session.mark("controlled-menu-reentry");
      const hooks = await app.evaluateHandle(
        ({ Menu }, { boundary, command, application }) => {
          const build = Menu.buildFromTemplate;
          const install = Menu.setApplicationMenu;
          let armed = true;
          let inputs = 0;
          const input = (menu: Electron.Menu | null) => {
            // Only the application menu carries the application section; the
            // tray menu built alongside it must not receive the injected command.
            const item = menu
              ?.getMenuItemById(application)
              ?.submenu?.getMenuItemById(command);
            if (!armed || !item) return;
            armed = false;
            inputs++;
            // Inject only the newer public visibility command at the native
            // boundary. Delegate the original native operation exactly once.
            // No preferences, behavior state or menu revisions are set by tests.
            item.click();
          };
          Menu.buildFromTemplate = function (template) {
            const menu = Reflect.apply(build, this, [template]);
            if (boundary === "build") input(menu);
            return menu;
          };
          Menu.setApplicationMenu = function (menu) {
            if (boundary === "install") input(menu);
            return Reflect.apply(install, this, [menu]);
          };
          return {
            inputs: () => inputs,
            restore: () => {
              armed = false;
              Menu.buildFromTemplate = build;
              Menu.setApplicationMenu = install;
            },
          };
        },
        { boundary, command, application: menuIds.application },
      );
      restore = () => hooks.evaluate((hooks) => hooks.restore());
      const observed = await app.evaluate(
        async ({ Menu, BrowserWindow, app }, application) => {
          // Dispatch user input on the ordinary main loop, rather than directly
          // interrupting a Node timer callback through inspector evaluation.
          // The controlled reentry inside the native menu boundary remains intact.
          await new Promise<void>((resolve) => setImmediate(resolve));
          const items = () =>
            Menu.getApplicationMenu()!.getMenuItemById(application)!.submenu!
              .items;
          // Activation refreshes the menu from the previous choice. A newer
          // command arrives while that native refresh is still in progress.
          app.emit("activate");
          return {
            menu: items().map((item) => item.id),
            visible: BrowserWindow.getAllWindows()
              .find((window) => window.getTitle() === "Mosey")!
              .isVisible(),
          };
        },
        menuIds.application,
      );
      const preferences: unknown = JSON.parse(
        await readFile(path.join(session.profile, "preferences.json"), "utf8"),
      );

      await writeFile(
        evidencePath(
          `${packaged ? "packaged" : "development"}-menu-reentry-${boundary}-${visible ? "show" : "hide"}.json`,
        ),
        JSON.stringify(
          {
            scope:
              "Controlled public input interleaving at the native menu boundary",
            scaleFactor: Number(scaleFactor),
            inputs: await hooks.evaluate((hooks) => hooks.inputs()),
            observed,
            preferences,
          },
          null,
          2,
        ),
      );
      expect(await hooks.evaluate((hooks) => hooks.inputs())).toBe(1);
      expect(preferences).toMatchObject({
        visibility: visible ? "visible" : "hidden",
      });
      expect(observed.visible).toBe(visible);
      expect(observed.menu).toContain(
        visible ? menuIds.hidePet : menuIds.showPet,
      );
      expect(observed.menu).not.toContain(command);
    } catch (error) {
      await app
        ?.windows()[0]
        ?.screenshot({
          path: evidencePath(
            `failure-menu-reentry-${boundary}-${visible ? "show" : "hide"}-${packaged ? "packaged" : "development"}.png`,
          ),
          timeout: 3000,
        })
        .catch(() => {});
      throw error;
    } finally {
      try {
        await restore?.().catch(() => {});
      } finally {
        await session.close();
      }
    }
  },
);
