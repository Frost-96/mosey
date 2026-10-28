import { createPetInteraction } from "./interaction";
import { PetMotion } from "./motion";
import { app, BrowserWindow, screen, ipcMain, powerMonitor } from "electron";
import path from "node:path";
import log from "electron-log/main";
import { createActor } from "xstate";
import { Timeline } from "../../behavior/timeline";
import { petBehavior, autonomy } from "../../behavior/pet-machine";
import { dockSupport } from "../../behavior/dock-support";
import {
  assetErrorSchema,
  channels,
  emptyRequestSchema,
  presentationSchema,
  type Presentation,
  type Settings,
} from "../../shared/contract";
import type { PetSize } from "../../shared/size";
import type { PreferencesStore } from "../platform/preferences";
import type { DockCapture } from "../platform/dock/capture";
import type { DockObservation } from "../platform/dock/runtime";
import { CharacterSwitch } from "./character-switch";

type Environment = {
  dock: Pick<DockCapture, "start" | "stop">;
  refreshMenus(): void;
  publishSettings(): void;
  bodyMenu(): Electron.MenuItemConstructorOptions[];
};

// Own one pet's live state. Callers issue commands and observe settings; window
// placement, input, behavior and renderer generations never become shared state.
export function createPetSession(
  preferences: PreferencesStore,
  environment: Environment,
) {
  const timeline = new Timeline();
  let visibility: Presentation["visibility"] = "hidden";
  let suspended = false;
  let rendererState: "loading" | "ready" | "failed" = "loading";
  let automaticRecoveryUsed = false;
  let rendererGeneration = 0;
  let quitting = false;
  app.on("will-quit", () => behavior.stop());
  const setVisibility = (next: "visible" | "hidden") => {
    if (!preferences.setVisibility(next)) return;
    interaction.dismissMenu();
    if (next === "hidden") pet.hide();
    else if (rendererState === "ready") {
      behavior.send({ type: "CANCEL" });
      interaction.invalidate();
      alignGround();
      pet.showInactive();
    }
    synchronizeVisibility();
    environment.refreshMenus();
    environment.publishSettings();
  };
  let geometryRevision = 0;
  let failedSize: PetSize | undefined;
  let liveSize = preferences.size;
  const area = screen.getPrimaryDisplay().workArea;
  const initialSide = liveSize;
  const pet = new BrowserWindow({
    title: "Mosey",
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
  const characters: CharacterSwitch = new CharacterSwitch(pet, preferences, {
    placement: (candidate) => {
      const bounds = pet.getBounds();
      return {
        posture: behavior.getSnapshot().value,
        suspended,
        gestureActive: interaction.gestureActive,
        menuOpen: interaction.menuOpen,
        dockFramePending: dockPendingAt !== undefined,
        footY: bounds.y + bounds.height,
        supports: [
          supportAt(bounds.x, bounds.y),
          supportAt(bounds.x, bounds.y, candidate.geometry),
        ],
      };
    },
    apply: () => {
      motion.stop();
      geometryRevision++;
      interaction.invalidate({ releaseInput: true });
      behavior.send({
        type: "CHARACTER",
        walkDurationMs: characters.current.walk?.durationMs ?? autonomy.walkMs,
        paused: visibility !== "visible",
      });
    },
    changed: environment.publishSettings,
  });
  const behavior = createActor(petBehavior, {
    clock: timeline,
    input: {
      now: timeline.now,
      walkDurationMs: characters.current.walk?.durationMs,
    },
  }).start();
  const interaction = createPetInteraction(pet, behavior, timeline, {
    get ready() {
      return rendererState === "ready";
    },
    get visibility() {
      return visibility;
    },
    get suspended() {
      return suspended;
    },
    get geometryRevision() {
      return geometryRevision;
    },
    get size() {
      return liveSize;
    },
    get character() {
      return characters.current;
    },
    stopMotion: () => motion.stop(),
    constrain: (x, y) => constrain(x, y),
    alignGround: () => alignGround(),
    reconcileDock: () => reconcileDock(),
    publish: () => publish(),
    bodyMenu: environment.bodyMenu,
  });
  const motion = new PetMotion(pet, behavior, {
    get now() {
      return movementNow();
    },
    get held() {
      return timeline.pausedAt !== undefined || dockPendingAt !== undefined;
    },
    get gestureActive() {
      return interaction.gestureActive;
    },
    get visible() {
      return visibility === "visible";
    },
    get size() {
      return liveSize;
    },
    get character() {
      return characters.current;
    },
    supportAt: (x, y) => supportAt(x, y),
    constrain: (x, y) => constrain(x, y),
    reconcile: () => reconcileDock(),
  });
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
  // Only an observed overlapping bottom edge owns vertical support. A null or
  // pending capture report cannot turn an unrelated desktop position into a drop.
  let dockSupported = false;
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
  const supportAt = (
    x: number,
    y: number,
    candidate = characters.current.geometry,
  ) => {
    const area = screen.getPrimaryDisplay().workArea;
    const floor = area.y + area.height;
    // Current side avoidance follows the last painted pose. A candidate
    // character starts at rest; support must fit before that switch commits.
    const pose =
      candidate === characters.current.geometry
        ? interaction.displayed
        : undefined;
    const body = candidate
      .frame({
        posture: pose?.posture ?? "resting",
        frame: pose?.frame ?? 0,
        direction: pose?.direction ?? behavior.getSnapshot().context.direction,
        size: liveSize,
      })
      ?.boundsAt({ x, y });
    if (!body) return { footY: floor, shiftX: 0 };
    if (dockObservation?.orientation === "bottom") {
      const contact = candidate.contactAt(liveSize, x);
      if (!contact) return { footY: floor, shiftX: 0 };
      body.left = contact.left;
      body.right = contact.right;
    }
    return dockSupport(dockObservation, body, floor);
  };
  const reconcileDock = () => {
    if (
      pet.isDestroyed() ||
      visibility !== "visible" ||
      suspended ||
      interaction.menuOpen ||
      dockPendingAt !== undefined ||
      interaction.gestureActive
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
    const area = screen.getPrimaryDisplay().workArea;
    const supported = support.footY < area.y + area.height - 1;
    const lostSupport = dockSupported && !supported;
    dockSupported = supported;
    if (!supported && !lostSupport) return;
    const footY = bounds.y + bounds.height;
    if (support.footY < footY - 1) behavior.send({ type: "CLIMB" });
    else if (support.footY > footY + 1) behavior.send({ type: "DROP" });
  };
  const observeDock = (
    observation: DockObservation | null,
    pending: boolean,
  ) => {
    const geometryChanged = dockObservation !== null || observation !== null;
    const wasPending = dockPendingAt !== undefined;
    dockObservation = observation;
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
  };
  const alignGround = () => {
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = pet.getBounds();
    const support = supportAt(bounds.x, bounds.y);
    constrain(
      bounds.x + support.shiftX,
      Math.min(area.y + area.height, support.footY) - bounds.height,
    );
  };
  const reconcileGround = () => {
    // The live work area can change before its native notification arrives.
    // Keep grounded poses on that floor without touching captured or moving pets.
    if (
      interaction.gestureActive ||
      motion.active ||
      dockPendingAt !== undefined
    )
      return;
    const posture = behavior.getSnapshot().value;
    if (
      posture === "dragging" ||
      posture === "flutter" ||
      posture === "falling"
    )
      return;
    const bounds = pet.getBounds();
    const support = supportAt(bounds.x, bounds.y);
    if (bounds.y + bounds.height !== support.footY) alignGround();
  };
  const presentation = () =>
    presentationSchema.parse({
      character: characters.current.id,
      posture:
        behavior.getSnapshot().value === "paused"
          ? "resting"
          : behavior.getSnapshot().value,
      direction: behavior.getSnapshot().context.direction,
      actionId: behavior.getSnapshot().context.actionId,
      startedAt: behavior.getSnapshot().context.startedAt + timeline.offset,
      frozenAt: timeline.pausedAt,
      visibility: suspended ? "hidden" : visibility,
      size: liveSize,
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
  ipcMain.on(channels.assetError, (event, value: unknown) => {
    if (!authorized(event)) return;
    const parsed = assetErrorSchema.safeParse(value);
    if (parsed.success) log.error("Pet asset error", parsed.data);
  });
  const publish = () => {
    if (!pet?.isDestroyed())
      pet?.webContents.send(channels.presentation, presentation());
  };
  const changeSize = (size: PetSize, commit = true) => {
    if (commit) {
      if (size !== preferences.size && !preferences.setSize(size)) {
        failedSize = size;
        size = preferences.size;
      } else failedSize = undefined;
    } else failedSize = undefined;
    if (size === liveSize) {
      environment.publishSettings();
      environment.refreshMenus();
      return;
    }
    liveSize = size;
    const old = pet.getBounds();
    const side = size;
    geometryRevision++;
    interaction.invalidate({ releaseInput: true });
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
    interaction.release();
    if (
      ["climbing", "falling"].includes(String(behavior.getSnapshot().value))
    ) {
      motion.stop();
      behavior.send({ type: "DROP" });
    }
    reconcileDock();
    publish();
    environment.publishSettings();
    environment.refreshMenus();
  };
  const commitPreview = () => {
    if (liveSize !== preferences.size) changeSize(liveSize);
  };
  app.on("before-quit", commitPreview);
  behavior.subscribe((snapshot) => {
    if (snapshot.value === "resting" && interaction.gestureActive) {
      behavior.send({ type: "PAUSE" });
      return;
    }
    motion.update(snapshot);
    publish();
    if (snapshot.value === "resting") reconcileDock();
  });
  const pause = () => {
    interaction.dismissMenu();
    suspended = true;
    dockSupported = false;
    dockPendingSince = undefined;
    finishDockPending();
    void environment.dock.stop();
    dockObservation = null;
    interaction.stopPolling();
    interaction.cancel();
    behavior.send({ type: "PAUSE" });
  };
  const resume = () => {
    suspended = false;
    alignGround();
    interaction.startPolling();
    if (visibility === "visible") {
      behavior.send({ type: "RESUME" });
      environment.dock.start();
    }
  };
  powerMonitor.on("suspend", pause);
  powerMonitor.on("lock-screen", pause);
  powerMonitor.on("resume", resume);
  powerMonitor.on("unlock-screen", resume);
  const displayChanged = () => {
    dockSupported = false;
    dockPendingSince = undefined;
    dockObservation = null;
    finishDockPending();
    interaction.cancel();
    void environment.dock.stop().then(() => {
      if (!pet.isDestroyed() && visibility === "visible" && !suspended)
        environment.dock.start();
    });
  };
  const displayMetricsChanged = (
    _event: Electron.Event,
    _display: Electron.Display,
    changedMetrics: string[],
  ) => {
    if (changedMetrics.length > 0) displayChanged();
  };
  screen.on("display-metrics-changed", displayMetricsChanged);
  screen.on("display-added", displayChanged);
  screen.on("display-removed", displayChanged);
  pet.on("unresponsive", interaction.cancel);
  pet.on("closed", () => {
    interaction.invalidate({ forgetGesture: true });
    motion.stop();
    powerMonitor.off("suspend", pause);
    powerMonitor.off("resume", resume);
    powerMonitor.off("unlock-screen", resume);
    powerMonitor.off("lock-screen", pause);
    screen.off("display-metrics-changed", displayMetricsChanged);
    screen.off("display-added", displayChanged);
    screen.off("display-removed", displayChanged);
  });
  pet.webContents.on("did-start-loading", interaction.cancel);
  app.on("before-quit", interaction.dismissMenu);
  app.on("before-quit", motion.stop);
  app.on("before-quit", finishDockPending);
  // Some packaged macOS launches update native visibility without delivering
  // show/hide notifications. Reconcile explicit operations and native state;
  // duplicate notifications must not reset a running action or click window.
  const synchronizeVisibility = () => {
    if (
      (rendererState !== "ready" || preferences.visibility === "hidden") &&
      pet.isVisible()
    )
      pet.hide();
    const next = pet.isVisible() ? "visible" : "hidden";
    if (visibility === next) return;
    visibility = next;
    if (next === "visible") {
      behavior.send({ type: suspended ? "PAUSE" : "RESUME" });
      if (!quitting && !suspended) {
        interaction.startPolling();
        environment.dock.start();
      }
    } else {
      dockSupported = false;
      dockPendingSince = undefined;
      finishDockPending();
      void environment.dock.stop();
      dockObservation = null;
      interaction.stopPolling();
      // Immediately release any last opaque region, independent of cursor polling.
      interaction.invalidate({ releaseInput: true });
      interaction.cancel();
      behavior.send({ type: "PAUSE" });
    }
    publish();
  };
  pet.on("show", synchronizeVisibility);
  pet.on("hide", synchronizeVisibility);
  // Native hide/show and work-area events can be omitted or coalesced. Keep a
  // bounded lifecycle check even when hidden; expensive pointer polling still
  // stops while hidden. Idempotent visibility updates preserve active actions.
  const nativeStatePoll = setInterval(() => {
    if (pet.isDestroyed()) return;
    synchronizeVisibility();
    if (visibility === "visible" && !suspended && !interaction.menuOpen)
      reconcileGround();
    characters.reconcile();
  }, 50);
  const stopNativeStatePolling = () => clearInterval(nativeStatePoll);
  pet.once("closed", stopNativeStatePolling);
  app.once("before-quit", stopNativeStatePolling);
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
  const retireRenderer = () => {
    // Hide and release native hit regions before any reload. Hidden intent is
    // a preference, so this operational hide must never write PreferencesStore.
    rendererState = "loading";
    rendererGeneration++;
    characters.retireRenderer();
    interaction.stopPolling();
    interaction.invalidate({ releaseInput: true, forgetGesture: true });
    pet.hide();
    synchronizeVisibility();
    interaction.cancel();
    behavior.send({ type: "PAUSE" });
    geometryRevision++;
    const area = screen.getPrimaryDisplay().workArea;
    const side = liveSize;
    pet.setBounds(
      {
        x: area.x + Math.round((area.width - side) / 2),
        y: area.y + area.height - side,
        width: side,
        height: side,
      },
      false,
    );
  };
  const loadPet = async () => {
    if (quitting || pet.isDestroyed()) return;
    retireRenderer();
    environment.refreshMenus();
    const generation = rendererGeneration;
    try {
      if (devURL) await pet.loadURL(devURL);
      else
        await pet.loadFile(
          path.join(
            import.meta.dirname,
            `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
          ),
        );
    } catch (error) {
      if (quitting || pet.isDestroyed() || generation !== rendererGeneration)
        return;
      log.error("Pet recovery load failed", error);
      retireRenderer();
      rendererState = "failed";
      environment.refreshMenus();
    }
  };
  pet.webContents.on("render-process-gone", (_event, details) => {
    log.error("Pet renderer exited", details.reason, details.exitCode);
    if (quitting || pet.isDestroyed()) return;
    if (!automaticRecoveryUsed) {
      automaticRecoveryUsed = true;
      void loadPet();
    } else {
      retireRenderer();
      rendererState = "failed";
      environment.refreshMenus();
    }
  });
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
  pet.webContents.on("did-finish-load", () => {
    if (quitting || rendererState !== "loading") return;
    rendererState = "ready";
    characters.rendererLoaded();
    alignGround();
    if (preferences.visibility === "visible") pet.showInactive();
    synchronizeVisibility();
    environment.refreshMenus();
  });
  return {
    get settings() {
      return {
        ...characters.settings,
        size: liveSize,
        visibility: preferences.visibility,
        failedSize,
      };
    },
    get failed() {
      return rendererState === "failed";
    },
    get capturePermitted() {
      return (
        !quitting &&
        rendererState === "ready" &&
        visibility === "visible" &&
        !suspended
      );
    },
    setVisibility,
    changeSize,
    selectCharacter: (character: Settings["character"]) =>
      characters.select(character),
    commitPreview,
    beginShutdown: () => {
      quitting = true;
    },
    observeDock,
    load: loadPet,
  };
}

export type PetSession = ReturnType<typeof createPetSession>;
