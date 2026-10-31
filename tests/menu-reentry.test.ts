import { test, expect } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

test.each([
  ["build", "Show Mosey"],
  ["build", "Hide Mosey"],
  ["install", "Show Mosey"],
  ["install", "Hide Mosey"],
] as const)(
  "menu %s preserves the newer %s choice",
  async (boundary, command) => {
    const visible = command === "Show Mosey";
    const session = await createPetTestSession({
      dock: "real",
      preferences: {
        version: 3,
        character: "corgi",
        visibility: visible ? "hidden" : "visible",
        size: 160,
      },
    });
    const { app, pet } = await session.launch();
    // Vite may finish dependency optimization after the first painted frame.
    await session.run("startup-network-idle", () =>
      pet.waitForLoadState("networkidle"),
    );
    const scaleFactor = await session.run("menu-reentry-scale", () =>
      pet.evaluate(() => devicePixelRatio),
    );
    expect(scaleFactor).toBe(
      Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
    );
    try {
      const hooks = await session.run("menu-reentry:app-evaluateHandle", () =>
        app.evaluateHandle(
          ({ Menu }, { boundary, command }) => {
            const build = Menu.buildFromTemplate;
            const install = Menu.setApplicationMenu;
            let armed = true;
            let inputs = 0;
            const input = (menu: Electron.Menu | null) => {
              const item = menu?.items
                .find((item) => item.label === "Mosey")
                ?.submenu?.items.find((item) => item.label === command);
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
          { boundary, command },
        ),
      );
      const observed = await session.run("menu-reentry:app-evaluate", () =>
        app.evaluate(async ({ Menu, BrowserWindow, app }) => {
          // Dispatch user input on the ordinary main loop, rather than directly
          // interrupting a Node timer callback through inspector evaluation.
          // The controlled reentry inside the native menu boundary remains intact.
          await new Promise<void>((resolve) => setImmediate(resolve));
          const items = () =>
            Menu.getApplicationMenu()!.items.find(
              (item) => item.label === "Mosey",
            )!.submenu!.items;
          // Activation refreshes the menu from the previous choice. A newer
          // command arrives while that native refresh is still in progress.
          app.emit("activate");
          return {
            menu: items().map((item) => item.label),
            visible: BrowserWindow.getAllWindows()
              .find((window) => window.getTitle() === "Mosey")!
              .isVisible(),
          };
        }),
      );
      const preferences: unknown = JSON.parse(
        await session.run("menu-reentry:readFile", () =>
          readFile(path.join(session.profile, "preferences.json"), "utf8"),
        ),
      );
      const inputs = await session.run("menu-reentry-input-count", () =>
        hooks.evaluate((hooks) => hooks.inputs()),
      );
      await session.run("menu-reentry:writeFile", () =>
        writeFile(
          `test-results/${packaged ? "packaged" : "development"}-menu-reentry-${boundary}-${visible ? "show" : "hide"}.json`,
          JSON.stringify(
            {
              scope:
                "Controlled public input interleaving at the native menu boundary",
              inputs,
              scaleFactor,
              sessionEvidence: session.evidence,
              observed,
              preferences,
            },
            null,
            2,
          ),
        ),
      );
      expect(inputs).toBe(1);
      expect(preferences).toMatchObject({
        visibility: visible ? "visible" : "hidden",
      });
      expect(observed.visible).toBe(visible);
      expect(observed.menu).toContain(visible ? "Hide Mosey" : "Show Mosey");
      expect(observed.menu).not.toContain(command);
      await session.run("menu-reentry:hooks-evaluate", () =>
        hooks.evaluate((hooks) => hooks.restore()),
      );
      await session.quit();
    } catch (error) {
      await session
        .run("menu-reentry-failure-screenshot", () =>
          pet.screenshot({
            path: `test-results/failure-menu-reentry-${boundary}-${visible ? "show" : "hide"}-${packaged ? "packaged" : "development"}.png`,
            timeout: 3000,
          }),
        )
        .catch(() => {});
      throw error;
    }
  },
);
