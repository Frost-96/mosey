import { realBehaviorAdapter, type BehaviorAdapter } from "./adapters";

// One active-time clock for behavior deadlines, animation and desktop motion.
// Native menus freeze this clock without transitioning the pet's behavior.
export class Timeline {
  offset = 0;
  pausedAt: number | undefined;
  private nextId = 0;
  private timers = new Map<
    number,
    { callback: () => void; due: number; cancel?: () => void }
  >();
  constructor(
    private readonly adapter: BehaviorAdapter = realBehaviorAdapter,
  ) {}

  now = () => (this.pausedAt ?? this.adapter.now()) - this.offset;
  random = () => this.adapter.random();
  presentation(startedAt: number) {
    const now = this.adapter.now();
    const wallOffset = this.adapter.toWallTime(now) - now;
    return {
      startedAt: startedAt + this.offset + wallOffset,
      frozenAt:
        this.pausedAt === undefined ? undefined : this.pausedAt + wallOffset,
    };
  }
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { callback, due: this.now() + delay });
    this.schedule(id);
    return id;
  };
  clearTimeout = (id: number) => {
    this.timers.get(id)?.cancel?.();
    this.timers.delete(id);
  };
  private schedule(id: number) {
    const entry = this.timers.get(id);
    if (!entry || this.pausedAt !== undefined) return;
    entry.cancel = this.adapter.schedule(
      () => {
        this.timers.delete(id);
        entry.callback();
      },
      Math.max(0, entry.due - this.now()),
    );
  }
  pause() {
    if (this.pausedAt !== undefined) return;
    this.pausedAt = this.adapter.now();
    for (const entry of this.timers.values()) entry.cancel?.();
  }
  resume() {
    if (this.pausedAt === undefined) return;
    this.offset += this.adapter.now() - this.pausedAt;
    this.pausedAt = undefined;
    for (const id of this.timers.keys()) this.schedule(id);
  }
}
