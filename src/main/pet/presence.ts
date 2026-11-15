// Presence answers whether the pet can be observed right now. It owns native
// window visibility, suspension (sleep or a locked screen) and quitting, so
// gates ask one judgment instead of rebuilding it from session closures. The
// module never imports Electron: the native window and the system events come
// only through the adapter passed at construction, the Electron adapter in
// production and the in-memory adapter in tooling tests, so these rules are
// verified without a desktop. It never sends behavior events and never calls
// footing, interaction or Dock capture: it reports transitions through one
// callback and callers act on them.
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
  // Subscribe to system events for the window's lifetime; the adapter
  // unsubscribes when the window closes.
  listen(inputs: PresenceInputs): void;
};

export function createPresence(
  adapter: PresenceAdapter,
  notify: (transition: PresenceTransition) => void,
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
  // Read native visibility. Returns the new visibility only when it changed.
  const synchronize = () => {
    const next = adapter.nativelyVisible();
    if (next === visible) return undefined;
    visible = next;
    settle();
    return next ? "visible" : "hidden";
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
    visibilityChanged: () => void synchronize(),
  });
  const setReady = (next: boolean) => {
    ready = next;
    settle();
  };
  return {
    beginShutdown() {
      quitting = true;
    },
    synchronize,
    rendererLoading: () => setReady(false),
    rendererLoaded: () => setReady(true),
    rendererFailed: () => setReady(false),
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
// sets directly, and system events the test delivers. setVisible changes the
// window silently, like a platform that omits or coalesces notifications;
// show and hide change it and notify.
export function createMemoryPresenceAdapter() {
  let visible = false;
  let inputs: PresenceInputs | undefined;
  const adapter = {
    nativelyVisible: () => visible,
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
