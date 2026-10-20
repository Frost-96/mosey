import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  screen,
  ipcMain,
} from "electron";
import path from "node:path";
import { DockValidation } from "./platform/dock-validation";
import log from "electron-log/main";
import { createActor } from "xstate";
import { petBehavior } from "./behavior/resting";
import {
  assetErrorSchema,
  channels,
  emptyRequestSchema,
  presentationSchema,
  type Presentation,
} from "./shared/contract";

// A second launch has no side effects: future hidden intent stays untouched.
if (!app.requestSingleInstanceLock()) app.quit();
else void start();

async function start() {
  // Retain the native tray for the entire application lifetime.
  const behavior = createActor(petBehavior).start();
  let visibility: Presentation["visibility"] = "visible";
  log.transports.file.maxSize = 1024 * 1024;
  log.transports.console.level = false;
  log.transports.ipc.level = false;
  app.on("will-quit", () => {
    tray?.destroy();
    behavior.stop();
  });
  await app.whenReady();
  app.dock?.hide();
  log.info("Mosey starting", {
    version: app.getVersion(),
    electron: process.versions.electron,
    arch: process.arch,
  });
  const quit = () => app.quit();
  let drained = false;
  const refreshMenus = () => {
    const diagnostic: Electron.MenuItemConstructorOptions = {
      label: "Dock validation",
      submenu: dockValidation.menu(),
    };
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Mosey",
          submenu: [
            {
              label: "Quit Mosey",
              accelerator: "CommandOrControl+Q",
              click: quit,
            },
          ],
        },
        diagnostic,
      ]),
    );
    tray.setContextMenu(
      Menu.buildFromTemplate([
        diagnostic,
        { label: "Quit Mosey", click: quit },
      ]),
    );
  };
  app.on("before-quit", (event) => {
    if (!drained) {
      event.preventDefault();
      void dockValidation.stop("application quit").finally(() => {
        drained = true;
        app.quit();
      });
    }
  });
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  );
  const tray = new Tray(icon);
  tray.setTitle("🐾");
  tray.setToolTip("Mosey");
  const dockValidation = new DockValidation(refreshMenus);
  refreshMenus();
  const area = screen.getPrimaryDisplay().workArea;
  const pet = new BrowserWindow({
    width: 240,
    height: 240,
    x: area.x + Math.round((area.width - 240) / 2),
    y: area.y + area.height - 240,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pet.setAlwaysOnTop(true, "floating");
  // Idle currently has no interactions. Do not obstruct the user's work.
  pet.setIgnoreMouseEvents(true);
  const presentation = () =>
    presentationSchema.parse({
      posture: behavior.getSnapshot().value,
      visibility,
    });
  const authorized = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  ) =>
    event.sender === pet?.webContents &&
    event.senderFrame === pet.webContents.mainFrame;
  ipcMain.handle(channels.getPresentation, (event, value: unknown) => {
    if (!authorized(event)) throw new Error("Untrusted presentation request");
    emptyRequestSchema.parse(value);
    return presentation();
  });
  ipcMain.on(channels.assetError, (event, value: unknown) => {
    if (!authorized(event)) return;
    const parsed = assetErrorSchema.safeParse(value);
    if (parsed.success) log.error("Pet asset error", parsed.data);
  });
  const publish = () => {
    if (!pet?.isDestroyed())
      pet?.webContents.send(channels.presentation, presentation());
  };
  behavior.subscribe(publish);
  pet.on("show", () => {
    visibility = "visible";
    publish();
  });
  pet.on("hide", () => {
    visibility = "hidden";
    publish();
  });
  pet.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  pet.webContents.on("will-navigate", (event, url) => {
    log.info("DEBUG-pr18 will-navigate", {
      url,
      isMainFrame: event.isMainFrame,
    });
    event.preventDefault();
  });
  pet.webContents.on(
    "did-start-navigation",
    (_event, url, _inPlace, isMainFrame) =>
      log.info("DEBUG-pr18 did-start-navigation", { url, isMainFrame }),
  );
  pet.webContents.on("did-fail-load", (_event, code, description) =>
    log.error("Pet load failed", code, description),
  );
  pet.webContents.on("render-process-gone", (_event, details) =>
    log.error("Pet renderer exited", details.reason),
  );
  const devOrigin = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
    : undefined;
  pet.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const allowed =
      url.protocol === "file:" ||
      url.protocol === "data:" ||
      (!!devOrigin &&
        (url.origin === devOrigin ||
          (url.protocol === "ws:" && url.host === new URL(devOrigin).host)));
    callback({ cancel: !allowed });
  });
  pet.webContents.on("console-message", (details) =>
    log.info("DEBUG-pr18 renderer-console", details.message),
  );
  pet.webContents.once("did-finish-load", () =>
    log.info("DEBUG-pr18 did-finish-load", {
      visible: pet.isVisible(),
      loading: pet.webContents.isLoading(),
    }),
  );
  pet.on("show", () =>
    log.info("DEBUG-pr18 show", { visible: pet.isVisible() }),
  );
  pet.on("hide", () =>
    log.info("DEBUG-pr18 hide", { visible: pet.isVisible() }),
  );
  pet.once("ready-to-show", () => {
    log.info("DEBUG-pr18 ready-to-show", { visible: pet.isVisible() });
    pet.showInactive();
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL)
    await pet.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else
    await pet.loadFile(
      path.join(
        import.meta.dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
    );
  app.on("window-all-closed", quit);
}
