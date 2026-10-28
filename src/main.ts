import { app } from "electron";
import log from "electron-log/main";
import { SettingsWindow } from "./main/settings-window";
import { LoginLaunch } from "./main/platform/login-launch";
import { PreferencesStore } from "./main/platform/preferences";
import { DockCapture } from "./main/platform/dock/capture";
import { ApplicationMenus } from "./main/menus";
import { createPetSession, type PetSession } from "./main/pet/session";

// A second launch has no side effects: future hidden intent stays untouched.
if (!app.requestSingleInstanceLock()) app.quit();
else void start();

async function start() {
  await app.whenReady();
  app.dock?.hide();
  log.transports.file.maxSize = 1024 * 1024;
  log.transports.console.level = false;
  log.transports.ipc.level = false;
  log.info("Mosey starting", {
    version: app.getVersion(),
    electron: process.versions.electron,
    arch: process.arch,
  });
  const preferences = new PreferencesStore(app.getPath("userData"));
  const loginLaunch = new LoginLaunch();
  const settings: SettingsWindow = new SettingsWindow({
    read: () => ({ ...pet.settings, login: loginLaunch.read() }),
    setCharacter: (character) => pet.selectCharacter(character),
    changeSize: (size, commit) => pet.changeSize(size, commit),
    showPet: () => pet.setVisibility("visible"),
    setLoginLaunch: (enabled) => {
      loginLaunch.setEnabled(enabled);
      menus.refresh();
      settings.publish();
    },
    openLoginSettings: async () => {
      await loginLaunch.openSettings();
      settings.publish();
      menus.refresh();
    },
    commitPreview: () => pet.commitPreview(),
  });
  const dockCapture: DockCapture = new DockCapture({
    permitted: () => pet.capturePermitted,
    observe: (observation, pending) => pet.observeDock(observation, pending),
    changed: () => menus.refresh(),
  });
  let drained = false;
  // Register the drain before the session's interaction/preview cleanup. A
  // native quit first retires starts, then waits for both capture processes.
  app.on("before-quit", (event) => {
    pet.beginShutdown();
    if (!drained) {
      event.preventDefault();
      void dockCapture.shutdown().finally(() => {
        drained = true;
        app.quit();
      });
    }
  });
  const pet: PetSession = createPetSession(preferences, {
    dock: dockCapture,
    refreshMenus: () => menus.refresh(),
    publishSettings: settings.publish,
    bodyMenu: () => menus.bodyTemplate(),
  });
  const menus: ApplicationMenus = new ApplicationMenus(
    {
      state: () => {
        const { size, visibility } = pet.settings;
        return { size, visibility, failed: pet.failed };
      },
      setVisibility: (next) => pet.setVisibility(next),
      changeSize: (size) => pet.changeSize(size),
      retry: () => pet.load(),
    },
    settings,
    loginLaunch,
    dockCapture,
  );
  app.on("activate", () => {
    menus.refresh();
    settings.publish();
  });
  menus.refresh();
  await pet.load();
  app.on("window-all-closed", () => app.quit());
}
