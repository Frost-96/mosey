// Presence answers whether the pet can be observed right now. It owns native
// window visibility, suspension (sleep or a locked screen) and quitting, so
// gates ask one judgment instead of rebuilding it from session closures. The
// module never imports Electron: the native window comes only through the
// adapter passed at construction, the Electron adapter in production and the
// in-memory adapter in tooling tests, so these rules are verified without a
// desktop. It never sends behavior events and never calls footing,
// interaction or Dock capture: callers act on what it reports.
//
// Two queries are the gates:
// - observable: renderer ready, window visible, not suspended, not quitting.
// - shown: window natively visible and not suspended. Only the presentation
//   published to the renderer reads it.
// Quitting is the one input that moves the queries apart: it ends observation
// but leaves the pet shown, so the renderer keeps painting it while Dock
// capture drains. The existing quit handling still owns that cleanup.
//
// For now the session tells presence when its renderer starts loading,
// finishes or fails, keeps the system event subscriptions, and acts on the
// visibility edge synchronize() returns. The raw dimension reads serve callers
// not yet moved onto the queries: renderer recovery (quitting) and the
// interaction and motion environments (visibility, suspended). The character
// switch also reads suspended, which neither query expresses: a hidden pet may
// still switch character, a sleeping one may not.

export type PresenceAdapter = {
  nativelyVisible(): boolean;
};

export function createPresence(adapter: PresenceAdapter) {
  let visible = false;
  let ready = false;
  let suspended = false;
  let quitting = false;
  return {
    beginShutdown() {
      quitting = true;
    },
    suspend() {
      suspended = true;
    },
    resume() {
      suspended = false;
    },
    // Read native visibility. Returns the new visibility only when it changed,
    // so duplicate or coalesced notifications never repeat a transition.
    synchronize() {
      const next = adapter.nativelyVisible();
      if (next === visible) return undefined;
      visible = next;
      return next ? "visible" : "hidden";
    },
    rendererLoading() {
      ready = false;
    },
    rendererLoaded() {
      ready = true;
    },
    rendererFailed() {
      ready = false;
    },
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

// Deterministic adapter for tests: one window whose native visibility the
// test sets directly.
export function createMemoryPresenceAdapter() {
  let visible = false;
  const adapter: PresenceAdapter & { setVisible(next: boolean): void } = {
    nativelyVisible: () => visible,
    setVisible(next) {
      visible = next;
    },
  };
  return adapter;
}
