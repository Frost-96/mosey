// Presence answers whether the pet can be observed right now. It owns native
// window visibility, suspension (sleep or a locked screen) and quitting, so
// gates ask one judgment instead of rebuilding it from session closures. The
// module never imports Electron: the native window, the stored display intent
// and the system events come only through the adapter passed at construction,
// the Electron adapter in production and the in-memory adapter in tooling
// tests, so these rules are verified without a desktop. It never sends
// behavior events and never calls footing, interaction or Dock capture: it
// reports transitions through one callback and callers act on them.
//
// Presence alone shows and hides the window. While the renderer is not ready
// or the intent is hidden, a visible window is hidden; when the renderer is
// ready and the intent is visible, an explicit operation shows it without
// taking focus. The intent belongs to the preferences store and presence only
// reads it, so an operational hide during a reload never becomes the user's
// choice. Every show first runs the caller's show preparation, unless the pet
// is suspended: preparation readies a pet about to be observed, and a
// suspended pet stays paused until it wakes. Native notifications only record
// visibility; hiding against them waits for the next reconcile.
//
// Two queries are the gates:
// - observable: renderer ready, window visible, not suspended, not quitting.
// - shown: window natively visible and not suspended. Only the presentation
//   published to the renderer reads it.
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
// existing quit handling still owns that cleanup. A pet still observed when
// quitting begins does report "unobserved" if it is then suspended or hidden.
//
// For now the session tells presence when its renderer starts loading,
// finishes or fails, and reconciles native visibility from its own state poll.
// The operations that can change visibility return the new visibility only
// when it changed, so the caller republishes its presentation.
// The raw dimension reads serve callers not yet moved onto the queries:
// renderer recovery (quitting) and the interaction and motion environments
// (visibility, suspended). The character switch also reads suspended, which
// neither query expresses: a hidden pet may still switch character, a sleeping
// one may not.

export type PresenceTransition = { type: "observed" } | { type: "unobserved" };

// The system events presence consumes. Adapters decide which platform events
// count as each one.
export type PresenceInputs = {
  suspend(): void;
  resume(): void;
  visibilityChanged(): void;
};

export type PresenceAdapter = {
  nativelyVisible(): boolean;
  // Show without taking focus.
  show(): void;
  hide(): void;
  // The user's display intent, read from the preferences store.
  intent(): "visible" | "hidden";
  // Subscribe to system events for the window's lifetime; the adapter
  // unsubscribes when the window closes.
  listen(inputs: PresenceInputs): void;
};

export function createPresence(
  adapter: PresenceAdapter,
  notify: (transition: PresenceTransition) => void,
  prepareShow: () => void,
) {
  let visible = false;
  let ready = false;
  let suspended = false;
  let quitting = false;
  // Whether the last reported transition was "observed".
  let observed = false;
  const settle = () => {
    const live = ready && visible && !suspended;
    if (observed && !live) {
      observed = false;
      notify({ type: "unobserved" });
    } else if (!observed && live && !quitting) {
      observed = true;
      notify({ type: "observed" });
    }
  };
  const synchronize = () => {
    visible = adapter.nativelyVisible();
    settle();
  };
  // Hide a window that must not be shown, then record what the window is.
  // The window may report its own change while it is shown or hidden, so the
  // result compares with the visibility before the whole operation.
  const align = (before = visible) => {
    if ((!ready || adapter.intent() === "hidden") && adapter.nativelyVisible())
      adapter.hide();
    synchronize();
    if (visible === before) return undefined;
    return visible ? "visible" : "hidden";
  };
  const showIntended = () => {
    const before = visible;
    if (ready && adapter.intent() === "visible") {
      if (!suspended) prepareShow();
      adapter.show();
    }
    return align(before);
  };
  adapter.listen({
    suspend() {
      suspended = true;
      settle();
    },
    resume() {
      suspended = false;
      settle();
    },
    visibilityChanged: synchronize,
  });
  const unready = () => {
    ready = false;
    return align();
  };
  return {
    beginShutdown() {
      quitting = true;
    },
    // Called from the caller's native state poll.
    reconcile: () => align(),
    // The stored intent changed.
    intentChanged: showIntended,
    rendererLoading: unready,
    rendererLoaded() {
      ready = true;
      return showIntended();
    },
    rendererFailed: unready,
    get observable() {
      return !quitting && ready && visible && !suspended;
    },
    get shown() {
      return visible && !suspended;
    },
    get visibility(): "visible" | "hidden" {
      return visible ? "visible" : "hidden";
    },
    get suspended() {
      return suspended;
    },
    get quitting() {
      return quitting;
    },
  };
}

export type Presence = ReturnType<typeof createPresence>;

// Deterministic adapter for tests: one window whose native visibility the test
// sets directly, a stored intent the test sets (visible by default), and
// system events the test delivers. setVisible changes the window silently,
// like a platform that omits or coalesces notifications; show and hide change
// it and notify.
export function createMemoryPresenceAdapter() {
  let visible = false;
  let intent: "visible" | "hidden" = "visible";
  let inputs: PresenceInputs | undefined;
  const adapter = {
    nativelyVisible: () => visible,
    intent: () => intent,
    setIntent(next: "visible" | "hidden") {
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
    suspend: () => inputs?.suspend(),
    resume: () => inputs?.resume(),
  };
  return adapter satisfies PresenceAdapter;
}
