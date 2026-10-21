import climbing from "./assets/generated/climbing-atlas.json";
import { DockRuntime, type DockObservation } from "./platform/dock-runtime";
import { dockSupport } from "./behavior/dock-support";
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
  let quitting = false;
  const setVisibility = (next: "visible" | "hidden") => {
    if (!preferences.setVisibility(next)) return;
    dismissBodyMenu();
    if (next === "hidden") pet.hide();
    else {
      behavior.send({ type: "CANCEL" });
      displayed = undefined;
      positionOnGround();
      pet.showInactive();
    }
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
  const dockItems = (): Electron.MenuItemConstructorOptions[] => [
    { label: dockRuntime.status, enabled: false },
    {
      label: "Retry Dock interaction",
      click: () => {
        void Promise.all([
          dockRuntime.stop(),
          dockValidation.stop("product Dock interaction requested"),
        ]).then(() => {
          startDock();
        });
      },
    },
  ];
  const refreshMenus = () => {
    const diagnostic: Electron.MenuItemConstructorOptions = {
      label: "Dock validation",
      submenu: dockValidation.menu().map((item) =>
        item.label === "Start Dock validation (120 seconds)"
          ? {
              ...item,
              click: () => {
                void dockRuntime.stop().then(() => {
                  if (!quitting) return dockValidation.start();
                });
              },
            }
          : item,
      ),
    };
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Mosey",
          submenu: [
            visibilityItem(),
            sizeItem(),
            ...dockItems(),
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
        ...dockItems(),
        diagnostic,
        { label: "Quit Mosey", click: quit },
      ]),
    );
  };
  app.on("before-quit", (event) => {
    quitting = true;
    if (!drained) {
      event.preventDefault();
      void Promise.all([
        dockValidation.stop("application quit"),
        dockRuntime.stop(),
      ]).finally(() => {
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
      reconcileDock();
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
    climbing,
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
  let dockObservation: DockObservation | null = null;
  let dockPendingAt: number | undefined;
  let dockPendingSince: number | undefined;
  let dockMovementDelay = 0;
  let dockPendingTimer: ReturnType<typeof setTimeout> | undefined;
  const movementNow = () =>
    (dockPendingAt ?? timeline.now()) - dockMovementDelay;
  const finishDockPending = () => {
    if (dockPendingAt !== undefined)
      dockMovementDelay += timeline.now() - dockPendingAt;
    dockPendingAt = undefined;
    clearTimeout(dockPendingTimer);
    dockPendingTimer = undefined;
  };
  const bodyAt = (x: number, y: number) => {
    const geometry = petGeometry(preferences.size);
    // Use the pose actually drawn, including facing, until its next frame
    // report. This is the same alpha mask and foot transform as input routing.
    const atlas =
      atlases.find((value) => value.action === displayed?.posture) ??
      atlases[0]!;
    const frame = atlas.frames[displayed?.frame ?? 0] ?? atlas.frames[0]!;
    const runs = frame.hitRows.flat();
    const localLeft = Math.min(...runs.map(([start]) => start));
    const localRight = Math.max(...runs.map(([, end]) => end));
    const top = frame.hitRows.findIndex((row) => row.length > 0);
    const left =
      geometry.foot.x +
      ((localLeft - frame.foot.x) / atlas.pixelRatio) * geometry.assetScale;
    const right =
      geometry.foot.x +
      ((localRight - frame.foot.x) / atlas.pixelRatio) * geometry.assetScale;
    const mirrored = displayed?.direction === "left";
    return {
      left: x + (mirrored ? geometry.side - right : left),
      right: x + (mirrored ? geometry.side - left : right),
      top:
        y +
        geometry.foot.y +
        ((top - frame.foot.y) / atlas.pixelRatio) * geometry.assetScale,
      bottom: y + geometry.foot.y,
    };
  };
  const supportAt = (x: number, y: number) => {
    const area = screen.getPrimaryDisplay().workArea;
    return dockSupport(dockObservation, bodyAt(x, y), area.y + area.height);
  };
  const reconcileDock = () => {
    if (
      pet.isDestroyed() ||
      visibility !== "visible" ||
      suspended ||
      bodyMenu ||
      dockPendingAt !== undefined ||
      gesture
    )
      return;
    const posture = String(behavior.getSnapshot().value);
    if (
      ["paused", "dragging", "flutter", "falling", "climbing"].includes(posture)
    )
      return;
    const bounds = pet.getBounds();
    const support = supportAt(bounds.x, bounds.y);
    if (support.shiftX) constrain(bounds.x + support.shiftX, bounds.y);
    const footY = bounds.y + bounds.height;
    if (support.footY < footY - 1) behavior.send({ type: "CLIMB" });
    else if (support.footY > footY + 1) behavior.send({ type: "DROP" });
  };
  let dockStatus = "";
  const dockRuntime = new DockRuntime((observation) => {
    const geometryChanged = dockObservation !== null || observation !== null;
    const wasPending = dockPendingAt !== undefined;
    dockObservation = observation;
    const pending = dockRuntime.processingFrame;
    if (pending) {
      dockPendingSince ??= performance.now();
      // A new complete frame invalidates the old edge immediately. Briefly
      // hold the current position while its worker finishes; never move using
      // that old geometry. The bounded hold cannot mask a stuck producer.
      if (
        performance.now() - dockPendingSince < 250 &&
        dockPendingAt === undefined
      ) {
        dockPendingAt = timeline.now();
        dockPendingTimer = setTimeout(() => {
          finishDockPending();
          reconcileDock();
        }, 250);
      }
    } else {
      dockPendingSince = undefined;
      finishDockPending();
    }
    // Repeated unavailable reports do not own desktop placement. Only a
    // capability change (or an ended pending frame) may initiate Dock motion.
    if (geometryChanged || (wasPending && !pending)) reconcileDock();
    if (dockStatus !== dockRuntime.status) {
      dockStatus = dockRuntime.status;
      refreshMenus();
    }
  });
  const startDock = () => {
    if (
      !quitting &&
      visibility === "visible" &&
      !suspended &&
      !dockValidation.running
    )
      dockRuntime.start();
  };
  refreshMenus();
  const alignGround = () => {
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = pet.getBounds();
    const support = supportAt(bounds.x, bounds.y);
    constrain(
      bounds.x + support.shiftX,
      Math.min(area.y + area.height, support.footY) - bounds.height,
    );
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
    // Establish the new stable location before publishing resting: otherwise
    // its Dock reconciliation can start a new climb from the old location.
    if (!pet.isDestroyed()) alignGround();
    behavior.send({
      type: visibility === "visible" && !suspended ? "CANCEL" : "PAUSE",
    });
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
      const returning = ["flutter", "falling", "landing", "climbing"].includes(
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
    if (
      ["climbing", "falling"].includes(String(behavior.getSnapshot().value))
    ) {
      stopMotion();
      behavior.send({ type: "DROP" });
    }
    reconcileDock();
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
      const started = movementNow();
      motion = setInterval(() => {
        if (timeline.pausedAt !== undefined || dockPendingAt !== undefined)
          return;
        if (
          pet.isDestroyed() ||
          gesture ||
          visibility !== "visible" ||
          behavior.getSnapshot().context.actionId !== id
        )
          return stopMotion();
        const progress = Math.min(
          1,
          (movementNow() - started) / autonomy.walkMs,
        );
        const bounds = pet.getBounds();
        // A size change preserves the moving foot, not the old window corner.
        const x =
          origin.x +
          origin.width / 2 +
          (destination - origin.x) * progress -
          bounds.width / 2;
        const support = supportAt(x, bounds.y);
        constrain(x + support.shiftX, bounds.y);
        reconcileDock();
      }, 16);
    } else if (
      snapshot.value === "climbing" &&
      motionAction !== snapshot.context.actionId
    ) {
      stopMotion();
      const id = snapshot.context.actionId;
      motionAction = id;
      const started = movementNow();
      const climbDurationMs = climbing.frames.reduce(
        (total, frame) => total + frame.durationMs,
        0,
      );
      let last = started;
      motion = setInterval(() => {
        if (timeline.pausedAt !== undefined || dockPendingAt !== undefined) {
          last = movementNow();
          return;
        }
        if (
          pet.isDestroyed() ||
          gesture ||
          visibility !== "visible" ||
          behavior.getSnapshot().context.actionId !== id
        )
          return stopMotion();
        const now = movementNow();
        const step = Math.min(50, now - last) * 0.11;
        last = now;
        const bounds = pet.getBounds();
        const target = supportAt(bounds.x, bounds.y).footY;
        const footY = bounds.y + bounds.height;
        if (target > footY + 1) {
          behavior.send({ type: "DROP" });
          return;
        }
        const next = Math.max(target, footY - step);
        constrain(bounds.x, next - bounds.height);
        if (next <= target + 1 && now - started >= climbDurationMs) {
          stopMotion();
          behavior.send({ type: "LANDED", actionId: id });
        }
      }, 16);
    } else if (
      snapshot.value !== "falling" &&
      snapshot.value !== "walking" &&
      snapshot.value !== "climbing"
    )
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
      const started = movementNow();
      // Initial velocity and acceleration in desktop points, adjustable here.
      motion = setInterval(() => {
        if (timeline.pausedAt !== undefined || dockPendingAt !== undefined)
          return;
        if (
          pet.isDestroyed() ||
          gesture ||
          behavior.getSnapshot().context.actionId !== id
        ) {
          stopMotion();
          return;
        }
        const seconds = (movementNow() - started) / 1000;
        const bounds = pet.getBounds();
        const y =
          footY - bounds.height + 180 * seconds + 1800 * seconds * seconds;
        const ground =
          supportAt(footX - bounds.width / 2, y).footY - bounds.height;
        if (ground < bounds.y - 1) {
          behavior.send({ type: "CLIMB" });
          return;
        }
        const support = supportAt(footX - bounds.width / 2, y);
        constrain(
          footX - bounds.width / 2 + support.shiftX,
          Math.min(y, ground),
        );
        if (y >= ground) {
          stopMotion();
          behavior.send({ type: "LANDED", actionId: id });
        }
      }, 16);
    }
    publish();
    if (snapshot.value === "resting") reconcileDock();
  });
  const pause = () => {
    dismissBodyMenu();
    suspended = true;
    void dockRuntime.stop();
    dockObservation = null;
    stopPointerPolling();
    cancelInteraction();
    behavior.send({ type: "PAUSE" });
  };
  const resume = () => {
    suspended = false;
    alignGround();
    startPointerPolling();
    if (visibility === "visible") {
      behavior.send({ type: "RESUME" });
      startDock();
    }
  };
  powerMonitor.on("suspend", pause);
  powerMonitor.on("lock-screen", pause);
  powerMonitor.on("resume", resume);
  powerMonitor.on("unlock-screen", resume);
  const displayChanged = () => {
    dockObservation = null;
    finishDockPending();
    cancelInteraction();
    void dockRuntime.stop().then(() => {
      if (!pet.isDestroyed() && visibility === "visible" && !suspended)
        startDock();
    });
  };
  screen.on("display-metrics-changed", displayChanged);
  screen.on("display-added", displayChanged);
  screen.on("display-removed", displayChanged);
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
    screen.off("display-metrics-changed", displayChanged);
    screen.off("display-added", displayChanged);
    screen.off("display-removed", displayChanged);
  });
  pet.webContents.on("did-start-loading", cancelInteraction);
  pet.webContents.on("render-process-gone", cancelInteraction);
  app.on("before-quit", dismissBodyMenu);
  app.on("before-quit", stopMotion);
  app.on("before-quit", finishDockPending);
  pet.on("show", () => {
    if (preferences.visibility === "hidden") {
      pet.hide();
      return;
    }
    visibility = "visible";
    behavior.send({ type: suspended ? "PAUSE" : "RESUME" });
    if (!quitting && !suspended) {
      startPointerPolling();
      startDock();
    }
    publish();
  });
  pet.on("hide", () => {
    visibility = "hidden";
    void dockRuntime.stop();
    dockObservation = null;
    stopPointerPolling();
    // Immediately release any last opaque region, independent of cursor polling.
    pet.setIgnoreMouseEvents(true, { forward: true });
    ignoring = true;
    displayed = undefined;
    cancelInteraction();
    behavior.send({ type: "PAUSE" });
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
