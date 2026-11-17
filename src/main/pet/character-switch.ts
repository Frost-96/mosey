import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import log from "electron-log/main";
import type { PreferencesStore } from "../platform/preferences";
import type { CharacterId } from "../../shared/character-catalog";
import { CharacterCatalog } from "../character-catalog";
import {
  channels,
  characterPreparedSchema,
  emptyRequestSchema,
  type CharacterPreparation,
  type Settings,
} from "../../shared/contract";

type Character = ReturnType<CharacterCatalog["load"]>;
type Request = Omit<CharacterPreparation, "assets"> & {
  candidate: Character;
  phase: "loading" | "waiting";
};

// The application answers whether a prepared candidate may replace the
// current character right now, and applies it synchronously. It never handles
// a request, preparation phase, timer or failure.
type Application = {
  ready(candidate: Character): boolean;
  apply(): void;
  changed(): void;
};

// Main-process owner of the complete selection, including the renderer's
// preparation handshake. The current bundle changes only after a durable save.
export class CharacterSwitch {
  private readonly renderer: WebContents;
  private readonly catalog = new CharacterCatalog();
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
    try {
      this.selected = this.catalog.load(preferences.character);
    } catch (error) {
      log.warn(
        "Unable to load the saved character",
        preferences.character,
        error,
      );
      this.selected = this.catalog.load("whale");
      this.failure = { target: preferences.character, reason: "load" };
    }
    this.catalog.commit(this.selected);
    ipcMain.handle(channels.getCharacter, (event, value: unknown) => {
      if (
        event.sender !== this.renderer ||
        event.senderFrame !== this.renderer.mainFrame
      )
        throw new Error("Untrusted character request");
      emptyRequestSchema.parse(value);
      return this.selected.prepared;
    });
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
    "character" | "characters" | "pendingCharacter" | "failedCharacter"
  > {
    return {
      character: this.selected.id,
      characters: this.catalog.list,
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
    try {
      const candidate = this.catalog.load(target);
      if (
        target !== this.selected.id ||
        candidate.resourceVersion !== this.selected.resourceVersion
      ) {
        this.pending = {
          request,
          generation: this.generation,
          character: target,
          resourceVersion: candidate.resourceVersion,
          candidate,
          phase: "loading",
        };
        const pending = this.pending;
        this.timer = setTimeout(() => {
          if (this.pending === pending) this.fail("load");
        }, 15000);
        this.prepare();
      }
    } catch (error) {
      // The settings window explains the failure in its own words; the
      // technical detail, such as missing pose names, stays in the log.
      log.warn("Unable to load the selected character", target, error);
      this.clearPending();
      this.failure = { target, reason: "load" };
    }
    this.catalog.retain(
      this.selected,
      ...(this.pending ? [this.pending.candidate] : []),
    );
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
    if (!this.application.ready(request.candidate)) return;
    // Native reads behind ready() can reenter application code. Recheck
    // identity after them, then keep validation, persistence and apply
    // synchronous.
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
    this.selected = request.candidate;
    this.catalog.commit(this.selected);
    this.clearPending();
    this.failure = undefined;
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
    const { request, generation, character, resourceVersion } = pending;
    this.renderer.send(channels.prepareCharacter, {
      request,
      generation,
      character,
      resourceVersion,
      assets: pending.candidate.prepared,
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
      result.data.character !== pending.character ||
      result.data.resourceVersion !== pending.resourceVersion
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
    this.catalog.retain(this.selected);
    if (!this.disposed && this.rendererReady && !this.renderer.isDestroyed())
      this.renderer.send(channels.retainCharacter, {
        request: this.sequence,
        generation: this.generation,
        character: this.selected.id,
        resourceVersion: this.selected.resourceVersion,
      });
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
    ipcMain.removeHandler(channels.getCharacter);
    ipcMain.off(channels.assetsReady, this.onAssetsReady);
    ipcMain.off(channels.characterPrepared, this.onPrepared);
    this.pet.off("closed", this.dispose);
    app.off("before-quit", this.dispose);
  };
}
