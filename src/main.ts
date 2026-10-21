import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  screen,
  ipcMain,
  powerMonitor,
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
import dragging from "./assets/generated/dragging-atlas.json";
import flutter from "./assets/generated/flutter-atlas.json";
import falling from "./assets/generated/falling-atlas.json";
import landing from "./assets/generated/landing-atlas.json";
import { petGeometry, type PetSize } from "./shared/size";
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
  let geometryRevision = 0;
  const sizeItem = (): Electron.MenuItemConstructorOptions => ({
    label: "Size",
    submenu: (["small", "medium", "large"] as const).map((size) => ({
      label: size[0]!.toUpperCase() + size.slice(1),
      type: "radio",
      checked: preferences.size === size,
      click: () => changeSize(size),
    })),
  });
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
            sizeItem(),
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
        sizeItem(),
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
  const initialSide = petGeometry(preferences.size).side;
  const pet = new BrowserWindow({
    width: initialSide,
    height: initialSide,
    x: area.x + Math.round((area.width - initialSide) / 2),
    y: area.y + area.height - initialSide,
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
  const atlases = [
    idle,
    tilt,
    paw,
    belly,
    dragging,
    flutter,
    falling,
    landing,
  ].map((value) => atlasSchema.parse(value));
  // Pointer identity outlives posture/action transitions during a captured gesture.
  let gesture:
    | {
        id: number;
        x: number;
        y: number;
        originX: number;
        originY: number;
        dragged: boolean;
      }
    | undefined;
  let motion: ReturnType<typeof setInterval> | undefined;
  let motionAction = -1;
  const stopMotion = () => {
    if (motion !== undefined) clearInterval(motion);
    motion = undefined;
    motionAction = -1;
  };
  const constrain = (x: number, y: number) => {
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = pet.getBounds();
    pet.setPosition(
      Math.round(
        Math.max(
          area.x,
          Math.min(x, area.x + Math.max(0, area.width - bounds.width)),
        ),
      ),
      Math.round(
        Math.max(
          area.y,
          Math.min(y, area.y + Math.max(0, area.height - bounds.height)),
        ),
      ),
      false,
    );
  };
  const alignGround = () => {
    const area = screen.getPrimaryDisplay().workArea;
    constrain(pet.getBounds().x, area.y + area.height - pet.getBounds().height);
  };
  const cancelInteraction = () => {
    gesture = undefined;
    stopMotion();
    behavior.send({ type: "CANCEL" });
    if (!pet.isDestroyed()) alignGround();
  };
  const release = (cancelled: boolean) => {
    if (!gesture) return;
    const dragged = gesture.dragged;
    gesture = undefined;
    if (dragged) behavior.send({ type: "RELEASE" });
    else if (!cancelled) behavior.send({ type: "CLICK" });
  };
  let displayed:
    | {
        actionId: number;
        frame: number;
        posture: Presentation["posture"];
      }
    | undefined;
  let ignoring = true;
  const hit = (x: number, y: number) => {
    // Until the next draw report, the previous pose is still what the user sees.
    // Behavior transitions must not create an ungrabbable frame between poses.
    if (!displayed || visibility !== "visible") return false;
    const visible = displayed;
    const atlas = atlases.find((value) => value.action === visible.posture);
    const frame = atlas?.frames[displayed.frame];
    if (!frame || !atlas) return false;
    const geometry = petGeometry(preferences.size);
    const localX = Math.floor(
      ((x - geometry.foot.x) / geometry.assetScale) * atlas.pixelRatio +
        frame.foot.x,
    );
    const localY = Math.floor(
      ((y - geometry.foot.y) / geometry.assetScale) * atlas.pixelRatio +
        frame.foot.y,
    );
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
    const next = !gesture && !hit(pointer.x - bounds.x, pointer.y - bounds.y);
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
      size: preferences.size,
      geometryRevision,
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
    if (
      "geometryRevision" in input &&
      input.geometryRevision !== geometryRevision
    )
      return;
    if (input.type === "move") {
      if (
        !gesture ||
        gesture.id !== input.gestureId ||
        visibility !== "visible"
      )
        return;
      const dx = input.screenX - gesture.x,
        dy = input.screenY - gesture.y;
      if (!gesture.dragged && Math.hypot(dx, dy) >= 5) {
        gesture.dragged = true;
        stopMotion();
        behavior.send({ type: "DRAG_START" });
      }
      if (gesture.dragged)
        constrain(gesture.originX + dx, gesture.originY + dy);
      return;
    }
    if (input.type === "release" || input.type === "cancel") {
      if (gesture?.id === input.gestureId) release(input.type === "cancel");
      routePointer();
      return;
    }
    if (
      !("actionId" in input) ||
      (input.actionId !== behavior.getSnapshot().context.actionId &&
        (input.type !== "press" || input.actionId !== displayed?.actionId))
    )
      return;
    if (input.type === "frame") {
      const atlas = atlases.find(
        (value) => value.action === behavior.getSnapshot().value,
      );
      if (!atlas?.frames[input.frame]) return;
      displayed = {
        actionId: input.actionId,
        frame: input.frame,
        posture: atlas.action,
      };
      routePointer();
    } else if (input.type === "press") {
      if (gesture || !hit(input.x, input.y)) return;
      const bounds = pet.getBounds();
      const returning = ["flutter", "falling", "landing"].includes(
        String(behavior.getSnapshot().value),
      );
      gesture = {
        id: input.gestureId,
        x: input.screenX,
        y: input.screenY,
        originX: bounds.x,
        originY: bounds.y,
        dragged: returning,
      };
      if (returning) {
        stopMotion();
        behavior.send({ type: "DRAG_START" });
      }
      routePointer();
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
  const changeSize = (size: PetSize) => {
    if (size === preferences.size) return;
    if (!preferences.setSize(size)) {
      refreshMenus();
      return;
    }
    const old = pet.getBounds();
    const side = petGeometry(size).side;
    geometryRevision++;
    displayed = undefined;
    pet.setIgnoreMouseEvents(true, { forward: true });
    ignoring = true;
    pet.setBounds(
      {
        x: old.x + Math.round((old.width - side) / 2),
        y: old.y + old.height - side,
        width: side,
        height: side,
      },
      false,
    );
    constrain(pet.getBounds().x, pet.getBounds().y);
    release(true);
    publish();
    refreshMenus();
  };
  behavior.subscribe((snapshot) => {
    // Rendering chooses poses by time. Only the main process moves the window.
    if (snapshot.value !== "falling") stopMotion();
    else if (motionAction !== snapshot.context.actionId) {
      stopMotion();
      const id = snapshot.context.actionId;
      motionAction = id;
      const origin = pet.getBounds();
      const footY = origin.y + origin.height;
      const footX = origin.x + origin.width / 2;
      const started = performance.now();
      // Initial velocity and acceleration in desktop points, adjustable here.
      motion = setInterval(() => {
        if (
          pet.isDestroyed() ||
          gesture ||
          behavior.getSnapshot().context.actionId !== id
        ) {
          stopMotion();
          return;
        }
        const seconds = (performance.now() - started) / 1000;
        const bounds = pet.getBounds();
        const y =
          footY - bounds.height + 180 * seconds + 1800 * seconds * seconds;
        const area = screen.getPrimaryDisplay().workArea;
        const ground = area.y + area.height - pet.getBounds().height;
        constrain(footX - bounds.width / 2, y);
        if (y >= ground) {
          stopMotion();
          behavior.send({ type: "LANDED", actionId: id });
        }
      }, 16);
    }
    publish();
  });
  powerMonitor.on("suspend", cancelInteraction);
  powerMonitor.on("lock-screen", cancelInteraction);
  screen.on("display-metrics-changed", cancelInteraction);
  screen.on("display-added", cancelInteraction);
  screen.on("display-removed", cancelInteraction);
  pet.on("unresponsive", cancelInteraction);
  pet.on("blur", () => {
    release(true);
    routePointer();
  });
  pet.on("closed", () => {
    gesture = undefined;
    stopMotion();
    powerMonitor.off("suspend", cancelInteraction);
    powerMonitor.off("lock-screen", cancelInteraction);
    screen.off("display-metrics-changed", cancelInteraction);
    screen.off("display-added", cancelInteraction);
    screen.off("display-removed", cancelInteraction);
  });
  pet.webContents.on("did-start-loading", cancelInteraction);
  pet.webContents.on("render-process-gone", cancelInteraction);
  app.on("before-quit", stopMotion);
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
    cancelInteraction();
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
