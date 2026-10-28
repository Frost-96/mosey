import { app, Menu, screen, ipcMain, type BrowserWindow } from "electron";
import type { ActorRefFrom } from "xstate";
import log from "electron-log/main";
import type { petBehavior } from "../../behavior/pet-machine";
import type { Timeline } from "../../behavior/timeline";
import {
  channels,
  inputSchema,
  type Presentation,
} from "../../shared/contract";
import type { PetSize } from "../../shared/size";
import type { CharacterSwitch } from "./character-switch";

type Environment = {
  readonly ready: boolean;
  readonly visibility: Presentation["visibility"];
  readonly suspended: boolean;
  readonly geometryRevision: number;
  readonly size: PetSize;
  readonly character: CharacterSwitch["current"];
  stopMotion(): void;
  constrain(x: number, y: number): void;
  alignGround(): void;
  reconcileDock(): void;
  publish(): void;
  bodyMenu(): Electron.MenuItemConstructorOptions[];
};

// Own captured pointer identity, the last painted hit region and native menu
// tracking. The session observes these facts but never writes gesture internals.
export function createPetInteraction(
  pet: BrowserWindow,
  behavior: ActorRefFrom<typeof petBehavior>,
  timeline: Timeline,
  environment: Environment,
) {
  let bodyMenu: Menu | undefined;
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
  const finishBodyMenu = (menu: Menu) => {
    if (bodyMenu !== menu) return;
    bodyMenu = undefined;
    timeline.resume();
    if (!pet.isDestroyed()) {
      environment.publish();
      routePointer();
      environment.reconcileDock();
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
  const cancelInteraction = () => {
    dismissBodyMenu();
    const cancelledGesture = gesture;
    gesture = undefined;
    if (cancelledGesture && !pet.isDestroyed())
      pet.webContents.send(channels.gestureCancellation, {
        gestureId: cancelledGesture.id,
      });
    environment.stopMotion();
    // Establish the new stable location before publishing resting: otherwise
    // its Dock reconciliation can start a new climb from the old location.
    if (!pet.isDestroyed()) environment.alignGround();
    behavior.send({
      type:
        environment.visibility === "visible" && !environment.suspended
          ? "CANCEL"
          : "PAUSE",
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
        environment.visibility === "visible" &&
        !environment.suspended
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
    if (
      !environment.ready ||
      !displayed ||
      environment.visibility !== "visible"
    )
      return false;
    return (
      environment.character.geometry
        .frame({ ...displayed, size: environment.size })
        ?.contains({ x, y }) ?? false
    );
  };
  const routePointer = () => {
    if (pet.isDestroyed() || environment.visibility !== "visible" || bodyMenu)
      return;
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
    if (pet.isDestroyed() || environment.visibility !== "visible") return;
    routePointer();
    pointerPoll ??= setInterval(routePointer, 8);
  };
  pet.on("closed", stopPointerPolling);
  const authorized = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  ) =>
    event.sender === pet?.webContents &&
    event.senderFrame === pet.webContents.mainFrame;
  ipcMain.on(channels.input, (event, value: unknown) => {
    if (
      !authorized(event) ||
      !environment.ready ||
      environment.visibility !== "visible" ||
      environment.suspended
    )
      return;
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) return;
    const input = parsed.data;
    if (
      "geometryRevision" in input &&
      input.geometryRevision !== environment.geometryRevision
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
        environment.publish();
        return;
      }
      timeline.pause();
      environment.publish();
      const menu = Menu.buildFromTemplate(environment.bodyMenu());
      bodyMenu = menu;
      app.focus({ steal: true });
      menu.once("menu-will-show", () => {
        if (
          bodyMenu !== menu ||
          environment.visibility !== "visible" ||
          environment.suspended
        )
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
        environment.visibility !== "visible"
      )
        return;
      const dx = input.screenX - gesture.x,
        dy = input.screenY - gesture.y;
      if (!gesture.dragged && Math.hypot(dx, dy) >= 5) {
        gesture.dragged = true;
        environment.stopMotion();
        behavior.send({ type: "DRAG_START" });
      }
      if (gesture.dragged)
        environment.constrain(gesture.originX + dx, gesture.originY + dy);
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
      const atlas = environment.character.atlases.find(
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
        environment.stopMotion();
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
        environment.stopMotion();
        behavior.send({ type: "DRAG_START" });
      } else if (behavior.getSnapshot().value === "resting") {
        behavior.send({ type: "PAUSE" });
      }
      routePointer();
    } else behavior.send({ type: "DONE", actionId: input.actionId });
  });
  pet.on("blur", () => {
    release(true);
    routePointer();
  });
  return {
    get gestureActive() {
      return gesture !== undefined;
    },
    get menuOpen() {
      return bodyMenu !== undefined;
    },
    get displayed() {
      return displayed;
    },
    invalidate({
      releaseInput = false,
      forgetGesture = false,
    }: { releaseInput?: boolean; forgetGesture?: boolean } = {}) {
      displayed = undefined;
      if (releaseInput) {
        pet.setIgnoreMouseEvents(true, { forward: true });
        ignoring = true;
      }
      if (forgetGesture) gesture = undefined;
    },
    cancel: cancelInteraction,
    release: () => release(true),
    dismissMenu: dismissBodyMenu,
    startPolling: startPointerPolling,
    stopPolling: stopPointerPolling,
  };
}
