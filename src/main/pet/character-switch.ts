import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import type { SnapshotFrom } from "xstate";
import type { petBehavior } from "../../behavior/pet-machine";
import type { PreferencesStore } from "../platform/preferences";
import {
  characterAssets,
  characterWalk,
  type CharacterId,
} from "../../shared/characters";
import { characterGeometry } from "../../shared/character-geometry";
import {
  channels,
  characterPreparedSchema,
  emptyRequestSchema,
  type CharacterPreparation,
  type Settings,
} from "../../shared/contract";

function loadCharacter(id: CharacterId) {
  const atlases = characterAssets(id);
  return {
    id,
    atlases,
    walk: characterWalk(id),
    geometry: characterGeometry(atlases),
  };
}

type Character = ReturnType<typeof loadCharacter>;
type Request = CharacterPreparation & {
  candidate: Character;
  phase: "loading" | "waiting";
};

// The application supplies live placement facts and one synchronous apply
// operation. It never handles a request, preparation phase, timer or failure.
type Application = {
  placement(candidate: Character): {
    posture: SnapshotFrom<typeof petBehavior>["value"];
    suspended: boolean;
    gestureActive: boolean;
    menuOpen: boolean;
    dockFramePending: boolean;
    footY: number;
    supports: [
      { footY: number; shiftX: number },
      { footY: number; shiftX: number },
    ];
  };
  apply(): void;
  changed(): void;
};

// Main-process owner of the complete selection, including the renderer's
// preparation handshake. The current bundle changes only after a durable save.
export class CharacterSwitch {
  private readonly renderer: WebContents;
  private selected: Character;
  private pending: Request | undefined;
  private failure: Settings["failedCharacter"];
  private sequence = 0;
  private generation = 0;
  private rendererReady = false;
  private assetsReady = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly pet: BrowserWindow,
    private readonly preferences: PreferencesStore,
    private readonly application: Application,
  ) {
    this.renderer = pet.webContents;
    this.selected = loadCharacter(preferences.character);
    ipcMain.on(channels.assetsReady, this.onAssetsReady);
    ipcMain.on(channels.characterPrepared, this.onPrepared);
    pet.once("closed", this.dispose);
    app.once("before-quit", this.dispose);
  }

  get current() {
    return this.selected;
  }

  get settings(): Pick<
    Settings,
    "character" | "pendingCharacter" | "failedCharacter"
  > {
    return {
      character: this.selected.id,
      pendingCharacter: this.pending && {
        target: this.pending.character,
        phase: this.pending.phase,
      },
      failedCharacter: this.failure,
    };
  }

  select(target: CharacterId) {
    if (this.disposed) return;
    this.clearPending();
    this.failure = undefined;
    const request = ++this.sequence;
    if (target !== this.selected.id) {
      try {
        this.pending = {
          request,
          generation: this.generation,
          character: target,
          candidate: loadCharacter(target),
          phase: "loading",
        };
        const pending = this.pending;
        this.timer = setTimeout(() => {
          if (this.pending === pending) this.fail("load");
        }, 15000);
        this.prepare();
      } catch {
        this.clearPending();
        this.failure = { target, reason: "load" };
      }
    }
    this.application.changed();
  }

  // Called with the application's native-state reconciliation: even hidden
  // pets receive this tick, without adding another polling loop or subscription.
  reconcile() {
    const request = this.pending;
    if (
      !request ||
      request.phase !== "waiting" ||
      !this.rendererReady ||
      request.generation !== this.generation ||
      this.disposed ||
      this.pet.isDestroyed()
    )
      return;
    const placement = this.application.placement(request.candidate);
    if (
      placement.suspended ||
      placement.gestureActive ||
      placement.menuOpen ||
      placement.dockFramePending ||
      ["dragging", "flutter", "falling", "landing", "climbing"].includes(
        placement.posture,
      )
    )
      return;
    // Both characters must already share this support. Never reposition the
    // window to accommodate the candidate's shape or a different Dock edge.
    if (
      placement.supports.some(
        (support) =>
          Math.abs(support.footY - placement.footY) > 1 || support.shiftX,
      )
    )
      return;
    // Native placement reads can reenter application code. Recheck identity
    // after them, then keep validation, persistence and apply synchronous.
    if (
      this.pending !== request ||
      request.generation !== this.generation ||
      !this.rendererReady ||
      this.disposed
    )
      return;
    if (!this.preferences.setCharacter(request.character)) {
      this.fail("save");
      return;
    }
    this.clearPending();
    this.failure = undefined;
    this.selected = request.candidate;
    this.application.apply();
    this.application.changed();
  }

  // Recovery retires all work prepared by that renderer. Retrying is a fresh
  // explicit selection, never an automatic replay of a superseded request.
  retireRenderer() {
    this.rendererReady = false;
    this.assetsReady = false;
    this.generation++;
    this.fail("recovery");
  }

  rendererLoaded() {
    if (this.disposed) return;
    this.rendererReady = true;
    this.prepare();
  }

  private authorized(event: IpcMainEvent) {
    return (
      !this.disposed &&
      !this.pet.isDestroyed() &&
      event.sender === this.renderer &&
      event.senderFrame === this.renderer.mainFrame
    );
  }

  private onAssetsReady = (event: IpcMainEvent, value: unknown) => {
    if (!this.authorized(event) || !emptyRequestSchema.safeParse(value).success)
      return;
    this.assetsReady = true;
    this.prepare();
  };

  private prepare() {
    const pending = this.pending;
    if (
      !pending ||
      pending.phase !== "loading" ||
      !this.assetsReady ||
      !this.rendererReady ||
      this.disposed
    )
      return;
    // A development document reload can lose its outstanding decode. Each
    // ready handshake may resend; request/phase checks retire duplicate replies.
    const { request, generation, character } = pending;
    this.renderer.send(channels.prepareCharacter, {
      request,
      generation,
      character,
    });
  }

  private onPrepared = (event: IpcMainEvent, value: unknown) => {
    if (!this.authorized(event)) return;
    const result = characterPreparedSchema.safeParse(value);
    const pending = this.pending;
    if (
      !result.success ||
      !pending ||
      pending.phase !== "loading" ||
      result.data.request !== pending.request ||
      result.data.generation !== this.generation ||
      result.data.generation !== pending.generation ||
      result.data.character !== pending.character
    )
      return;
    this.clearTimer();
    if (!result.data.success) return this.fail("load");
    pending.phase = "waiting";
    this.application.changed();
    this.reconcile();
  };

  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clearPending() {
    this.clearTimer();
    this.pending = undefined;
  }

  private fail(reason: NonNullable<Settings["failedCharacter"]>["reason"]) {
    if (!this.pending) return;
    this.failure = { target: this.pending.character, reason };
    this.clearPending();
    this.application.changed();
  }

  private dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.clearPending();
    ipcMain.off(channels.assetsReady, this.onAssetsReady);
    ipcMain.off(channels.characterPrepared, this.onPrepared);
    this.pet.off("closed", this.dispose);
    app.off("before-quit", this.dispose);
  };
}
