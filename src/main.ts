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
import { PreferencesStore } from "./platform/preferences";
import { DockValidation } from "./platform/dock-validation";
import log from "electron-log/main";
import { createActor } from "xstate";
import { petBehavior } from "./behavior/resting";
import {
  assetErrorSchema,
  channels,
  emptyRequestSchema,
  presentationSchema,
  inputSchema,
  type Presentation,
} from "./shared/contract";

import idle from "./assets/generated/idle-atlas.json";
import tilt from "./assets/generated/tilt-atlas.json";
import paw from "./assets/generated/paw-atlas.json";
import belly from "./assets/generated/belly-atlas.json";
import { atlasSchema } from "./shared/assets";

// A second launch has no side effects: future hidden intent stays untouched.
if (!app.requestSingleInstanceLock()) app.quit();
else void start();

async function start() {
  // Retain the native tray for the entire application lifetime.
  const behavior = createActor(petBehavior).start();
  let visibility: Presentation["visibility"] = "hidden";
  log.transports.file.maxSize = 1024 * 1024;
  log.transports.console.level = false;
  log.transports.ipc.level = false;
  app.on("will-quit", () => {
    tray?.destroy();
    behavior.stop();
  });
  await app.whenReady();
  app.dock?.hide();
  const preferences = new PreferencesStore(app.getPath("userData"));
  log.info("Mosey starting", {
    version: app.getVersion(),
    electron: process.versions.electron,
    arch: process.arch,
  });
  const quit = () => app.quit();
  let drained = false;
  const visibilityItem = (): Electron.MenuItemConstructorOptions => ({
    label: preferences.visibility === "visible" ? "Hide Mosey" : "Show Mosey",
    click: () => {
      const next = preferences.visibility === "visible" ? "hidden" : "visible";
      if (!preferences.setVisibility(next)) return;
      if (next === "hidden") pet.hide();
      else {
        behavior.send({ type: "CANCEL" });
        displayed = undefined;
        positionOnGround();
        pet.showInactive();
      }
      refreshMenus();
    },
  });
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
            visibilityItem(),
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
        visibilityItem(),
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
    acceptFirstMouse: true,
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
  pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const positionOnGround = () => {
    const ground = screen.getPrimaryDisplay().workArea;
    const { width, height } = pet.getBounds();
    pet.setPosition(
      ground.x + Math.round((ground.width - width) / 2),
      ground.y + ground.height - height,
    );
  };
  pet.setIgnoreMouseEvents(true, { forward: true });
  const atlases = [idle, tilt, paw, belly].map((value) =>
    atlasSchema.parse(value),
  );
  let displayed: { actionId: number; frame: number } | undefined;
  let ignoring = true;
  const hit = (x: number, y: number) => {
    const snapshot = behavior.getSnapshot();
    if (
      !displayed ||
      displayed.actionId !== snapshot.context.actionId ||
      visibility !== "visible"
    )
      return false;
    const atlas = atlases.find((value) => value.action === snapshot.value);
    const frame = atlas?.frames[displayed.frame];
    if (!frame || !atlas) return false;
    const localX = Math.floor((x - 120) * atlas.pixelRatio + frame.foot.x);
    const localY = Math.floor((y - 240) * atlas.pixelRatio + frame.foot.y);
    return (
      frame.hitRows[localY]?.some(
        ([start, end]) => localX >= start && localX < end,
      ) ?? false
    );
  };
  const routePointer = () => {
    if (pet.isDestroyed() || visibility !== "visible") return;
    const pointer = screen.getCursorScreenPoint();
    const bounds = pet.getBounds();
    const next = !hit(pointer.x - bounds.x, pointer.y - bounds.y);
    if (next !== ignoring) {
      pet.setIgnoreMouseEvents(next, { forward: true });
      ignoring = next;
    }
  };
  // Polling is a best-effort adapter: an enter-and-click within this interval
  // can race the OS. Real first-click acceptance remains a separate gate.
  let pointerPoll: ReturnType<typeof setInterval> | undefined;
  const stopPointerPolling = () => {
    if (pointerPoll !== undefined) clearInterval(pointerPoll);
    pointerPoll = undefined;
  };
  const startPointerPolling = () => {
    if (pet.isDestroyed() || visibility !== "visible") return;
    routePointer();
    pointerPoll ??= setInterval(routePointer, 8);
  };
  pet.on("closed", stopPointerPolling);
  const presentation = () =>
    presentationSchema.parse({
      posture: behavior.getSnapshot().value,
      actionId: behavior.getSnapshot().context.actionId,
      startedAt: behavior.getSnapshot().context.startedAt,
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
  ipcMain.on(channels.input, (event, value: unknown) => {
    if (!authorized(event) || visibility !== "visible") return;
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) return;
    const input = parsed.data;
    if (input.actionId !== behavior.getSnapshot().context.actionId) return;
    if (input.type === "frame") {
      const atlas = atlases.find(
        (value) => value.action === behavior.getSnapshot().value,
      );
      if (!atlas?.frames[input.frame]) return;
      displayed = { actionId: input.actionId, frame: input.frame };
      routePointer();
    } else if (input.type === "click") {
      if (hit(input.x, input.y)) behavior.send({ type: "CLICK" });
    } else behavior.send({ type: "DONE", actionId: input.actionId });
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
    if (preferences.visibility === "hidden") {
      pet.hide();
      return;
    }
    visibility = "visible";
    startPointerPolling();
    publish();
  });
  pet.on("hide", () => {
    visibility = "hidden";
    stopPointerPolling();
    // Immediately release any last opaque region, independent of cursor polling.
    pet.setIgnoreMouseEvents(true, { forward: true });
    ignoring = true;
    displayed = undefined;
    behavior.send({ type: "CANCEL" });
    publish();
  });
  const devURL = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).href
    : undefined;
  const devOrigin = devURL ? new URL(devURL).origin : undefined;
  pet.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  pet.webContents.on("will-navigate", (event, url) => {
    // Allow reload of only the exact configured development entry.
    // Keep every other navigation, and every packaged navigation, blocked.
    if (!devURL || url !== devURL) event.preventDefault();
  });
  pet.webContents.on("did-fail-load", (_event, code, description) =>
    log.error("Pet load failed", code, description),
  );
  pet.webContents.on("render-process-gone", (_event, details) =>
    log.error("Pet renderer exited", details.reason),
  );
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
  pet.once("ready-to-show", () => {
    if (preferences.visibility === "visible") pet.showInactive();
  });
  if (devURL) await pet.loadURL(devURL);
  else
    await pet.loadFile(
      path.join(
        import.meta.dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
    );
  app.on("window-all-closed", quit);
}
