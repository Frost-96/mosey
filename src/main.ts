import settling from "./assets/generated/settling-atlas.json";
import waking from "./assets/generated/waking-atlas.json";
import ear from "./assets/generated/ear-atlas.json";
import sleeping from "./assets/generated/sleeping-atlas.json";
import walking from "./assets/generated/walking-atlas.json";
import stretching from "./assets/generated/stretching-atlas.json";
import playing from "./assets/generated/playing-atlas.json";
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
import { Timeline } from "./behavior/timeline";
import { petBehavior, autonomy } from "./behavior/resting";
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
  const timeline = new Timeline();
  const behavior = createActor(petBehavior, {
    clock: timeline,
    input: { now: timeline.now },
  }).start();
  let bodyMenu: Menu | undefined;
  let visibility: Presentation["visibility"] = "hidden";
  let suspended = false;
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
  let loginError: string | undefined;
  const setLoginLaunch = (openAtLogin: boolean) => {
    if (process.platform !== "darwin" || !app.isPackaged) return;
    loginError = undefined;
    try {
      app.setLoginItemSettings({ type: "mainAppService", openAtLogin });
      const actual = app.getLoginItemSettings({ type: "mainAppService" });
      const registered = ["enabled", "requires-approval"].includes(
        actual.status,
      );
      if (registered !== openAtLogin)
        loginError = "Login launch change failed; try System Settings";
    } catch (error) {
      loginError = "Login launch change failed; try System Settings";
      log.warn("Unable to change login item settings", error);
    }
    refreshMenus();
  };
  const loginItems = (): Electron.MenuItemConstructorOptions[] => {
    const supported = process.platform === "darwin" && app.isPackaged;
    let settings: Electron.LoginItemSettings | undefined;
    try {
      if (process.platform === "darwin")
        settings = app.getLoginItemSettings({ type: "mainAppService" });
    } catch (error) {
      log.warn("Unable to read login item settings", error);
    }
    return [
      {
        label: "Launch at Login",
        type: "checkbox",
        checked: settings?.status === "enabled" && settings.openAtLogin,
        enabled: supported && !!settings,
        // mainAppService resolves this running .app itself. Never register the
        // development executable or store a JSON preference competing with macOS.
        click: (item) => setLoginLaunch(item.checked),
      },
      ...(settings?.status === "requires-approval"
        ? [
            {
              label: "Cancel Pending Login Launch",
              click: () => setLoginLaunch(false),
            },
          ]
        : []),
      ...(loginError ? [{ label: loginError, enabled: false }] : []),
      ...(!supported || !settings || settings.status === "requires-approval"
        ? [
            {
              label: !supported
                ? "Login launch requires the packaged macOS app"
                : !settings
                  ? "Login launch status unavailable"
                  : "Allow Mosey in System Settings → General → Login Items",
              enabled: false,
            },
          ]
        : []),
    ];
  };
  const setVisibility = (next: "visible" | "hidden") => {
    if (!preferences.setVisibility(next)) return;
    dismissBodyMenu();
    if (next === "hidden") pet.hide();
    else {
      behavior.send({ type: "CANCEL" });
      displayed = undefined;
      alignGround();
      pet.showInactive();
    }
    synchronizeVisibility();
    refreshMenus();
  };
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
    click: () =>
      setVisibility(
        preferences.visibility === "visible" ? "hidden" : "visible",
      ),
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
            ...loginItems(),
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
    return Menu.buildFromTemplate([
      visibilityItem(),
      sizeItem(),
      ...loginItems(),
      diagnostic,
      { label: "Quit Mosey", click: quit },
    ]);
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
  // macOS's cached native context menu does not provide a reliable pre-open
  // callback. Open explicitly so every click reads the current system setting.
  const openTrayMenu = () => tray.popUpContextMenu(refreshMenus());
  tray.on("click", openTrayMenu);
  tray.on("right-click", openTrayMenu);
  app.on("activate", refreshMenus);
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
  const finishBodyMenu = (menu: Menu) => {
    if (bodyMenu !== menu) return;
    bodyMenu = undefined;
    timeline.resume();
    if (!pet.isDestroyed()) {
      publish();
      routePointer();
    }
  };
  const dismissBodyMenu = () => {
    const menu = bodyMenu;
    if (!menu) return;
    menu.closePopup(pet);
    // Lifecycle cancellation owns the pause even if the OS never opened its
    // tracking loop and therefore does not deliver a popup completion callback.
    finishBodyMenu(menu);
  };
  pet.setIgnoreMouseEvents(true, { forward: true });
  const atlases = [
    settling,
    waking,
    ear,
    sleeping,
    idle,
    walking,
    stretching,
    playing,
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
    dismissBodyMenu();
    const cancelledGesture = gesture;
    gesture = undefined;
    if (cancelledGesture && !pet.isDestroyed())
      pet.webContents.send(channels.gestureCancellation, {
        gestureId: cancelledGesture.id,
      });
    stopMotion();
    behavior.send({
      type: visibility === "visible" && !suspended ? "CANCEL" : "PAUSE",
    });
    if (!pet.isDestroyed()) alignGround();
  };
  const release = (cancelled: boolean) => {
    if (!gesture) return;
    const dragged = gesture.dragged;
    gesture = undefined;
    if (dragged) behavior.send({ type: "RELEASE" });
    else {
      if (
        behavior.getSnapshot().value === "paused" &&
        visibility === "visible" &&
        !suspended
      )
        behavior.send({ type: "RESUME" });
      if (!cancelled) behavior.send({ type: "CLICK" });
    }
  };
  let displayed:
    | {
        actionId: number;
        frame: number;
        posture: Presentation["posture"];
        direction: Presentation["direction"];
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
      (((visible.direction === "left" ? geometry.side - x : x) -
        geometry.foot.x) /
        geometry.assetScale) *
        atlas.pixelRatio +
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
    if (pet.isDestroyed() || visibility !== "visible" || bodyMenu) return;
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
      posture:
        behavior.getSnapshot().value === "paused"
          ? "resting"
          : behavior.getSnapshot().value,
      direction: behavior.getSnapshot().context.direction,
      actionId: behavior.getSnapshot().context.actionId,
      startedAt: behavior.getSnapshot().context.startedAt + timeline.offset,
      frozenAt: timeline.pausedAt,
      visibility: suspended ? "hidden" : visibility,
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
    if (!authorized(event) || visibility !== "visible" || suspended) return;
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) return;
    const input = parsed.data;
    if (
      "geometryRevision" in input &&
      input.geometryRevision !== geometryRevision
    )
      return;
    if (input.type === "context") {
      if (
        bodyMenu ||
        gesture ||
        !hit(input.x, input.y) ||
        (input.actionId !== behavior.getSnapshot().context.actionId &&
          input.actionId !== displayed?.actionId)
      ) {
        publish();
        return;
      }
      timeline.pause();
      publish();
      const menu = Menu.buildFromTemplate([
        { label: "Hide Mosey", click: () => setVisibility("hidden") },
        { label: "Quit Mosey", click: quit },
      ]);
      bodyMenu = menu;
      app.focus({ steal: true });
      menu.once("menu-will-show", () => {
        if (bodyMenu !== menu || visibility !== "visible" || suspended)
          menu.closePopup(pet);
      });
      try {
        menu.popup({
          window: pet,
          frame: pet.webContents.mainFrame,
          x: Math.round(input.x),
          y: Math.round(input.y),
          callback: () => finishBodyMenu(menu),
        });
      } catch (error) {
        log.error("Unable to open pet context menu", error);
        finishBodyMenu(menu);
      }
      return;
    }
    if (bodyMenu) return;
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
        direction: behavior.getSnapshot().context.direction,
      };
      routePointer();
    } else if (input.type === "press") {
      if (gesture || !hit(input.x, input.y)) return;
      if (
        ["walking", "stretching", "playing"].includes(
          String(behavior.getSnapshot().value),
        )
      ) {
        stopMotion();
        behavior.send({ type: "CANCEL" });
      }
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
      } else if (behavior.getSnapshot().value === "resting") {
        behavior.send({ type: "PAUSE" });
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
    if (snapshot.value === "resting" && gesture) {
      behavior.send({ type: "PAUSE" });
      return;
    }
    // Rendering chooses poses by time. Only the main process moves the window.
    if (
      snapshot.value === "walking" &&
      motionAction !== snapshot.context.actionId
    ) {
      stopMotion();
      const id = snapshot.context.actionId;
      motionAction = id;
      alignGround();
      const origin = pet.getBounds();
      const area = screen.getPrimaryDisplay().workArea;
      let direction = snapshot.context.direction === "left" ? -1 : 1;
      // At an edge, use the available direction instead of walking in place.
      if (
        origin.x + direction * autonomy.walkDistance < area.x ||
        origin.x + direction * autonomy.walkDistance >
          area.x + area.width - origin.width
      )
        direction *= -1;
      if ((direction < 0 ? "left" : "right") !== snapshot.context.direction) {
        behavior.send({
          type: "FACE",
          direction: direction < 0 ? "left" : "right",
        });
      }
      const destination = Math.max(
        area.x,
        Math.min(
          origin.x + direction * autonomy.walkDistance,
          area.x + Math.max(0, area.width - origin.width),
        ),
      );
      const started = timeline.now();
      motion = setInterval(() => {
        if (timeline.pausedAt !== undefined) return;
        if (
          pet.isDestroyed() ||
          gesture ||
          visibility !== "visible" ||
          behavior.getSnapshot().context.actionId !== id
        )
          return stopMotion();
        const progress = Math.min(
          1,
          (timeline.now() - started) / autonomy.walkMs,
        );
        const bounds = pet.getBounds();
        const area = screen.getPrimaryDisplay().workArea;
        // A size change preserves the moving foot, not the old window corner.
        constrain(
          origin.x +
            origin.width / 2 +
            (destination - origin.x) * progress -
            bounds.width / 2,
          area.y + area.height - bounds.height,
        );
      }, 16);
    } else if (snapshot.value !== "falling" && snapshot.value !== "walking")
      stopMotion();
    else if (
      snapshot.value === "falling" &&
      motionAction !== snapshot.context.actionId
    ) {
      stopMotion();
      const id = snapshot.context.actionId;
      motionAction = id;
      const origin = pet.getBounds();
      const footY = origin.y + origin.height;
      const footX = origin.x + origin.width / 2;
      const started = timeline.now();
      // Initial velocity and acceleration in desktop points, adjustable here.
      motion = setInterval(() => {
        if (timeline.pausedAt !== undefined) return;
        if (
          pet.isDestroyed() ||
          gesture ||
          behavior.getSnapshot().context.actionId !== id
        ) {
          stopMotion();
          return;
        }
        const seconds = (timeline.now() - started) / 1000;
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
  const pause = () => {
    dismissBodyMenu();
    suspended = true;
    stopPointerPolling();
    cancelInteraction();
    behavior.send({ type: "PAUSE" });
  };
  const resume = () => {
    suspended = false;
    alignGround();
    startPointerPolling();
    if (visibility === "visible") behavior.send({ type: "RESUME" });
  };
  powerMonitor.on("suspend", pause);
  powerMonitor.on("lock-screen", pause);
  powerMonitor.on("resume", resume);
  powerMonitor.on("unlock-screen", resume);
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
    powerMonitor.off("suspend", pause);
    powerMonitor.off("resume", resume);
    powerMonitor.off("unlock-screen", resume);
    powerMonitor.off("lock-screen", pause);
    screen.off("display-metrics-changed", cancelInteraction);
    screen.off("display-added", cancelInteraction);
    screen.off("display-removed", cancelInteraction);
  });
  pet.webContents.on("did-start-loading", cancelInteraction);
  pet.webContents.on("render-process-gone", cancelInteraction);
  app.on("before-quit", dismissBodyMenu);
  app.on("before-quit", stopMotion);
  // Some packaged macOS launches update native visibility without delivering
  // show/hide notifications. Reconcile explicit operations too; delayed or
  // duplicate notifications must not reset a running action or click window.
  const synchronizeVisibility = () => {
    if (preferences.visibility === "hidden" && pet.isVisible()) pet.hide();
    const next = pet.isVisible() ? "visible" : "hidden";
    if (visibility === next) return;
    visibility = next;
    if (next === "visible") {
      behavior.send({ type: suspended ? "PAUSE" : "RESUME" });
      if (!suspended) startPointerPolling();
    } else {
      stopPointerPolling();
      // Immediately release any last opaque region, independent of cursor polling.
      pet.setIgnoreMouseEvents(true, { forward: true });
      ignoring = true;
      displayed = undefined;
      cancelInteraction();
      behavior.send({ type: "PAUSE" });
    }
    publish();
  };
  pet.on("show", synchronizeVisibility);
  pet.on("hide", synchronizeVisibility);
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
    synchronizeVisibility();
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
