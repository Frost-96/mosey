import { test, expect } from "vitest";
import { createPetTestSession } from "./support/pet-session";
import { openSettings, closeSettings } from "./support/settings";

test("opening settings waits for confirmed values instead of the initial React view", async () => {
  const session = await createPetTestSession({ dock: "real" });
  try {
    const { app } = await session.launch();
    session.mark("read-initial-settings");
    const first = await openSettings(app);
    const snapshot = await first.evaluate(() => window.moseySettings.get());
    await closeSettings(app);
    // Hold incoming settings at the IPC boundary until the native window is
    // observed visible, then release a non-default size and approval state.
    await app.evaluate(({ app, ipcMain }, snapshot) => {
      const pending: (() => void)[] = [];
      let released = false;
      const deliver = (send: () => void) => {
        if (released) send();
        else pending.push(send);
      };
      const next = {
        ...snapshot,
        revision: 10000,
        size: 110,
        login: { status: "requires-approval" },
      };
      ipcMain.removeHandler("settings:get");
      ipcMain.handle(
        "settings:get",
        () => new Promise((resolve) => deliver(() => resolve(next))),
      );
      app.on("browser-window-created", (_event, window) => {
        const send = window.webContents.send.bind(window.webContents);
        window.webContents.send = (channel, ...args) => {
          if (channel === "settings:state") deliver(() => send(channel, next));
          else send(channel, ...args);
        };
        const isVisible = window.isVisible.bind(window);
        let scheduled = false;
        window.isVisible = () => {
          const visible = isVisible();
          if (visible && !scheduled) {
            scheduled = true;
            setTimeout(() => {
              released = true;
              pending.splice(0).forEach((release) => release());
            }, 200);
          }
          return visible;
        };
      });
    }, snapshot);
    session.mark("delayed-settings-confirmation");
    const settings = await openSettings(app);
    expect(await settings.locator("output").textContent()).toBe("110");
    expect(await settings.getByRole("checkbox").isChecked()).toBe(false);
    expect(await settings.getByRole("checkbox").isDisabled()).toBe(true);
    expect(await settings.locator("#login-status").textContent()).toContain(
      "等待批准",
    );
  } finally {
    await session.close();
  }
});
