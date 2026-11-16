// Presence answers whether the pet can be observed right now. It owns native
// window visibility, suspension, the renderer lifecycle and quitting, so gates ask one judgment instead of rebuilding it
// from session closures. The module never imports Electron: the native window,
// the stored display intent, renderer loads and the system events come only
// through the adapter passed at construction, the Electron adapter in
// production and the in-memory adapter in tooling tests, so these rules are
// verified without a desktop. It never sends behavior events and never calls
// footing, interaction or Dock capture: it reports transitions through one
// callback and callers act on them.
//
// Presence alone shows and hides the window. While the renderer is not ready
// or the intent is hidden, a visible window is hidden; when the renderer is
// ready and the intent is visible, an explicit operation shows it without
// taking focus. The intent belongs to the preferences store and presence only
// reads it, so an operational hide during a reload never becomes the user's
// choice. Every show first runs the caller's show preparation, which learns
// whether the pet is suspended: preparation readies a pet about to be
// observed, and a suspended pet is shown but stays paused until it wakes.
// Native notifications only record visibility; hiding against them waits for
// the next reconcile.
//
// Suspension has two independent reasons: the system is asleep, or the screen
// is locked. The pet is suspended while either holds, and stops being
// suspended only once both have cleared. Waking clears only sleep and
// unlocking only the lock, so the order they arrive in never matters and a pet
// that wakes behind a locked screen stays suspended. Reporting a reason that
// already holds, or clearing one that does not, changes nothing.
//
// The renderer is loading, ready or failed. Every load, first or retried,
// retires the current renderer: the pet is hidden first, so a stop of
// observation meets a hidden pet, and "rendererRetired" follows. Only the
// latest load's failure counts; an earlier one is stale and dropped. A page
// load makes a loading renderer ready ("rendererReady") before the pet is
// shown. The first renderer exit reloads once automatically; a later exit or a
// failed load makes the renderer failed ("rendererFailed"). A manual retry
// loads the same way and never restores the automatic recovery, so an exit
// after a retry fails at once.
//
// Two queries are the gates:
// - observable: renderer ready, window visible, not suspended, not quitting.
//   Session gates read it: Dock capture, Dock coordination, ground
//   reconciliation and the daily action menu.
// - shown: window natively visible and not suspended. The presentation
//   published to the renderer reads it, and so do interaction and motion,
//   which hold presence directly. Shown does not imply a ready renderer: the
//   platform can show the window natively, and presence hides it again only
//   at the next operation or reconcile. Quitting leaves the pet shown, so through
//   the quit drain it keeps moving and taking input.
//
// Transitions mark the edges of observation: "observed" when the pet starts
// being observed, "unobserved" when it stops. Each edge is reported once, so
// duplicate or coalesced native notifications never repeat one.
//
// Quitting is the one exception where transitions and the queries part:
// beginning to quit makes observable false and blocks every later "observed",
// but never reports "unobserved". During quit the pet stays shown while Dock
// capture drains; running the stop sequence there would freeze it mid-wait,
// and its footing reset would stop capture alongside quit's own cleanup. The
// session's before-quit handlers own that cleanup: they dismiss the menu, stop
// motion, end the footing hold and stop the native state poll. A pet still
// observed when quitting begins does report "unobserved" if it is then
// suspended or hidden.
// Quitting also ends the renderer lifecycle: no load starts, and no page load,
// exit or load failure is acted on.
//
// The session reconciles native visibility from its own state poll. The
// operations that can change visibility return whether it changed, so the
// caller republishes its presentation.
//
// Three raw dimensions stay readable beside the queries, each for a judgment
// neither query expresses. The character switch reads suspended: a hidden pet
// may still switch character, a sleeping one may not. Interaction reads ready
// beside shown: a pet the platform showed before its renderer is ready takes
// no input. The session reads failed to offer a manual retry.

import type { Preferences } from "../platform/preferences";

export type PresenceTransition =
  | { type: "observed" }
  | { type: "unobserved" }
  | { type: "rendererRetired" }
  | { type: "rendererReady" }
  // A failed load carries its error; a repeated exit carries none.
  | { type: "rendererFailed"; error?: unknown };

// The system events presence consumes. Adapters decide which platform events
// count as each one.
export type PresenceInputs = {
  // The system sleeps or wakes.
  sleep(): void;
  wake(): void;
  // The screen locks or unlocks.
  lock(): void;
  unlock(): void;
  visibilityChanged(): void;
  // The renderer's page finished loading.
  rendererLoaded(): void;
  // The renderer process exited.
  rendererGone(): void;
};

export type PresenceAdapter = {
  nativelyVisible(): boolean;
  // Show without taking focus.
  show(): void;
  hide(): void;
  // The user's display intent, read from the preferences store.
  intent(): Preferences["visibility"];
  // Load the renderer's page; rejects when the load fails.
  load(): Promise<unknown>;
  // The window is gone; nothing more can be loaded into it.
  destroyed(): boolean;
  // Subscribe to system events for the window's lifetime; the adapter
  // unsubscribes when the window closes.
  listen(inputs: PresenceInputs): void;
};

export type PresenceOptions = {
  // Receives every transition, in order.
  notify(transition: PresenceTransition): void;
  // Runs just before presence shows the window. A suspended pet is shown but
  // stays paused until it wakes, so its preparation must not start it afresh.
  prepareShow(show: { suspended: boolean }): void;
};

type RendererState = "loading" | "ready" | "failed";

export function createPresence(
  adapter: PresenceAdapter,
  { notify, prepareShow }: PresenceOptions,
) {
  let visible = false;
  let renderer: RendererState = "loading";
  // A load result belongs to the generation it started in.
  let generation = 0;
  let automaticRecoveryUsed = false;
  let sleeping = false;
  let locked = false;
  const isSuspended = () => sleeping || locked;
  let quitting = false;
  // Whether the last reported transition was "observed".
  let observed = false;
  // Everything observation needs except not quitting, which ends
  // observability without reporting a stop.
  const live = () => renderer === "ready" && visible && !isSuspended();
  // Report the observation edge, if any, since the last report.
  const reportEdge = () => {
    if (observed && !live()) {
      observed = false;
      notify({ type: "unobserved" });
    } else if (!observed && live() && !quitting) {
      observed = true;
      notify({ type: "observed" });
    }
  };
  // Record what the window natively is, then report any edge.
  const readNative = () => {
    visible = adapter.nativelyVisible();
    reportEdge();
  };
  // Hide a window that must not be shown, then record what the window is.
  // Returns whether visibility changed. The window may report its own change
  // while it is shown or hidden, so the result compares with the visibility
  // before the whole operation.
  const hideUnwanted = (before = visible) => {
    if (
      (renderer !== "ready" || adapter.intent() === "hidden") &&
      adapter.nativelyVisible()
    )
      adapter.hide();
    readNative();
    return visible !== before;
  };
  const showIntended = () => {
    const before = visible;
    if (renderer === "ready" && adapter.intent() === "visible") {
      prepareShow({ suspended: isSuspended() });
      adapter.show();
    }
    return hideUnwanted(before);
  };
  // Hide before anything else learns of the reload, so a stop of observation
  // meets a hidden pet.
  const retire = () => {
    renderer = "loading";
    generation++;
    hideUnwanted();
    notify({ type: "rendererRetired" });
  };
  const fail = (error?: unknown) => {
    retire();
    renderer = "failed";
    notify(
      error === undefined
        ? { type: "rendererFailed" }
        : { type: "rendererFailed", error },
    );
  };
  const load = async () => {
    if (quitting || adapter.destroyed()) return;
    retire();
    const current = generation;
    try {
      await adapter.load();
    } catch (error) {
      if (quitting || adapter.destroyed() || current !== generation) return;
      fail(error);
    }
  };
  adapter.listen({
    sleep() {
      sleeping = true;
      reportEdge();
    },
    wake() {
      sleeping = false;
      reportEdge();
    },
    lock() {
      locked = true;
      reportEdge();
    },
    unlock() {
      locked = false;
      reportEdge();
    },
    visibilityChanged: readNative,
    rendererLoaded() {
      if (quitting || renderer !== "loading") return;
      renderer = "ready";
      notify({ type: "rendererReady" });
      showIntended();
    },
    rendererGone() {
      if (quitting || adapter.destroyed()) return;
      if (automaticRecoveryUsed) return fail();
      automaticRecoveryUsed = true;
      void load();
    },
  });
  return {
    beginShutdown() {
      quitting = true;
    },
    // Called from the caller's native state poll.
    reconcile: () => hideUnwanted(),
    // The stored intent changed.
    intentChanged: showIntended,
    // First load and manual retry alike.
    load,
    get ready() {
      return renderer === "ready";
    },
    get failed() {
      return renderer === "failed";
    },
    get observable() {
      return !quitting && live();
    },
    get shown() {
      return visible && !isSuspended();
    },
    get suspended() {
      return isSuspended();
    },
  };
}

export type Presence = ReturnType<typeof createPresence>;

// Deterministic adapter for tests: one window whose native visibility the test
// sets directly, a stored intent the test sets (visible by default), renderer
// loads the test settles, and system events the test delivers. setVisible
// changes the window silently, like a platform that omits or coalesces
// notifications; show and hide change it and notify.
export function createMemoryPresenceAdapter() {
  let visible = false;
  let intent: Preferences["visibility"] = "visible";
  let inputs: PresenceInputs | undefined;
  // Every load requested, oldest first; each settles when the test says.
  const loads: { resolve(): void; reject(error: unknown): void }[] = [];
  const adapter = {
    nativelyVisible: () => visible,
    intent: () => intent,
    destroyed: () => false,
    setIntent(next: Preferences["visibility"]) {
      intent = next;
    },
    listen(next: PresenceInputs) {
      inputs = next;
    },
    setVisible(next: boolean) {
      visible = next;
    },
    show() {
      visible = true;
      inputs?.visibilityChanged();
    },
    hide() {
      visible = false;
      inputs?.visibilityChanged();
    },
    load: () =>
      new Promise<void>((resolve, reject) => loads.push({ resolve, reject })),
    loads,
    sleep: () => inputs?.sleep(),
    wake: () => inputs?.wake(),
    lock: () => inputs?.lock(),
    unlock: () => inputs?.unlock(),
    finishLoad: () => inputs?.rendererLoaded(),
    exitRenderer: () => inputs?.rendererGone(),
  };
  return adapter satisfies PresenceAdapter;
}
