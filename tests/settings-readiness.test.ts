import { test, expect, vi } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startForge } from "./support/forge";
import { openSettings, closeSettings } from "./support/settings";
import { createPetTestSession } from "./support/pet-session";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("opening settings waits for confirmed values instead of the initial React view", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-settings-ready-"));
  let app: ElectronApplication | undefined;
  let stop: (() => Promise<void>) | undefined;
  try {
    if (!packaged) stop = await startForge();
    else
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [`--user-data-dir=${path.join(root, "profile")}`],
          }
        : { args: [".", `--user-data-dir=${path.join(root, "profile")}`] },
    );
    await app.firstWindow();
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
    const settings = await openSettings(app);
    expect(await settings.locator("output").textContent()).toBe("110");
    expect(await settings.getByRole("checkbox").isChecked()).toBe(false);
    expect(await settings.getByRole("checkbox").isDisabled()).toBe(true);
    expect(await settings.locator("#login-status").textContent()).toContain(
      "等待批准",
    );
  } finally {
    await app?.close();
    await stop?.();
    await rm(root, { recursive: true, force: true });
  }
});


test("a stalled settings close cancels reopening and profile writes while retaining process evidence", async () => {
  const session = await createPetTestSession({ dock: "empty" });
  const { app } = await session.launch();
  await openSettings(app, { run: session.run });
  const child = app.process();
  // Stop the native close at the driver boundary. The real application still
  // belongs to the session, whose cancellation must prevent all later work.
  const stalled = vi.spyOn(app, "evaluate").mockImplementationOnce(
    () => new Promise(() => {}),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closing = closeSettings(app, {
      run: (label, action) => session.run(label, action, {
        timeout: label === "settings-native-close" ? 100 : 5000,
      }),
    });
    await expect(Promise.race([
      closing,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Settings close ignored the session deadline")), 4000);
      }),
    ])).rejects.toThrow(/settings-native-close did not complete within 100ms/);
    await expect(openSettings(app, { run: session.run })).rejects.toThrow(/closed or cancelled/);
    await expect(session.writeProfileFile("after-close.json", "unexpected")).rejects.toThrow(/closed or cancelled/);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    const evidence = await readFile(path.join(session.evidence, "progress.jsonl"), "utf8");
    expect(evidence).toContain('"event":"first-failure"');
    expect(evidence).toContain("settings-native-close did not complete within 100ms");
    expect(evidence).toContain('"event":"app-exited"');
    expect(evidence).toContain('"event":"cleanup-complete"');
  } finally {
    clearTimeout(timer);
    stalled.mockRestore();
    await session.close();
  }
});
