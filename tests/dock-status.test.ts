import { test, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";

test("diagnostic status keeps the latest Retry during a native permission query", async () => {
  // No capture starts: hidden intent and the actual OS permission result remain.
  const session = await createPetTestSession({
    dock: "real",
    preferences: {
      version: 3,
      character: "corgi",
      visibility: "hidden",
      size: 160,
    },
  });
  const { app } = await session.launch();
  try {
    const invoke = (section: string, label: string) =>
      session.run("app-.evaluate", () =>
        app!.evaluate(
          ({ Menu }, { section, label }) => {
            Menu.getApplicationMenu()!
              .items.find((item) => item.label === section)!
              .submenu!.items.find((item) => item.label === label)!
              .click();
          },
          { section, label },
        ),
      );
    const created = session.run("app.waitForEvent", () =>
      app.waitForEvent("window"),
    );
    await invoke("Dock validation", "Show Dock validation status");
    const diagnostic = await created;
    await expect
      .poll(() =>
        session.run("diagnostic.getByRole--status--.innerText", () =>
          diagnostic.getByRole("status").innerText(),
        ),
      )
      .toBe("Not started");
    const hooks = await session.run("app.evaluateHandle", () =>
      app.evaluateHandle(({ BrowserWindow, Menu, systemPreferences }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.getTitle() === "Mosey Dock validation",
        )!;
        const contents = window.webContents;
        const originalPermission = systemPreferences.getMediaAccessStatus;
        const originalLoad = contents.loadURL;
        const state = {
          armed: false,
          dispatches: 0,
          started: 0,
          pending: 0,
          permissionReads: 0,
        };
        contents.loadURL = function (this: typeof contents, ...args) {
          state.started++;
          state.pending++;
          try {
            return Reflect.apply(originalLoad, this, args).finally(() => {
              state.pending--;
            });
          } catch (error) {
            state.pending--;
            throw error;
          }
        };
        systemPreferences.getMediaAccessStatus = function (
          this: typeof systemPreferences,
          mediaType,
        ) {
          // Delegate exactly once with the real argument and preserve its return
          // and exception. Inject only the public Retry input at this boundary.
          const value = Reflect.apply(originalPermission, this, [mediaType]);
          state.permissionReads++;
          if (mediaType === "screen" && state.armed) {
            state.armed = false;
            state.dispatches++;
            Menu.getApplicationMenu()!
              .items.find((item) => item.label === "Mosey")!
              .submenu!.items.find(
                (item) => item.label === "Retry Dock interaction",
              )!
              .click();
          }
          return value;
        };
        return {
          state,
          windowID: window.id,
          restore: () => {
            state.armed = false;
            systemPreferences.getMediaAccessStatus = originalPermission;
            if (!contents.isDestroyed()) contents.loadURL = originalLoad;
          },
        };
      }),
    );
    await session.run("hooks.evaluate", () =>
      hooks.evaluate((hooks) => {
        hooks.state.armed = true;
      }),
    );
    await invoke("Dock validation", "Stop Dock validation");
    expect(
      await session.run("hooks.evaluate", () =>
        hooks.evaluate((hooks) => hooks.state.dispatches),
      ),
    ).toBe(1);
    await expect
      .poll(
        async () => {
          const first = await session.run("hooks.evaluate", () =>
            hooks.evaluate((hooks) => ({ ...hooks.state })),
          );
          if (!first.started || first.pending) return false;
          await session.run("app-.evaluate", () =>
            app!.evaluate(
              () => new Promise<void>((resolve) => setImmediate(resolve)),
            ),
          );
          const last = await session.run("hooks.evaluate", () =>
            hooks.evaluate((hooks) => ({ ...hooks.state })),
          );
          const windowID = await session.run("diagnostic-window-id", () =>
            hooks.evaluate((hooks) => hooks.windowID),
          );
          const idle = await session.run("app-.evaluate", () =>
            app!.evaluate(
              ({ BrowserWindow }, id) =>
                !BrowserWindow.fromId(id)!.webContents.isLoading(),
              windowID,
            ),
          );
          return idle && !last.pending && first.started === last.started;
        },
        { timeout: 5000 },
      )
      .toBe(true);
    const final = await session.run(
      "diagnostic.getByRole--status--.innerText",
      () => diagnostic.getByRole("status").innerText(),
    );
    const trace = await session.run("diagnostic-trace", () =>
      hooks.evaluate((hooks) => hooks.state),
    );
    await session.run("writeFile", () =>
      writeFile(
        path.join(session.evidence, "dock-status-reentry.json"),
        JSON.stringify({
          scope:
            "Controlled public input interleaving; real permission result; no capture; not proof that the native API caused historical runs",
          trace,
          final,
        }),
      ),
    );
    expect(final).toBe("Stopped: product Dock interaction requested");
    await session.run("hooks.evaluate", () =>
      hooks.evaluate((hooks) => hooks.restore()),
    );
    await session.quit();
  } finally {
    await session.close();
  }
});
