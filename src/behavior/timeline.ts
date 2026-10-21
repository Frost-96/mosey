// One active-time clock for behavior deadlines, animation and desktop motion.
// Native menus freeze this clock without transitioning the pet's behavior.
export class Timeline {
  offset = 0;
  pausedAt: number | undefined;
  private nextId = 0;
  private timers = new Map<
    number,
    { callback: () => void; due: number; timer?: ReturnType<typeof setTimeout> }
  >();
  now = () => (this.pausedAt ?? Date.now()) - this.offset;
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { callback, due: this.now() + delay });
    this.schedule(id);
    return id;
  };
  clearTimeout = (id: number) => {
    clearTimeout(this.timers.get(id)?.timer);
    this.timers.delete(id);
  };
  private schedule(id: number) {
    const entry = this.timers.get(id);
    if (!entry || this.pausedAt !== undefined) return;
    entry.timer = setTimeout(
      () => {
        this.timers.delete(id);
        entry.callback();
      },
      Math.max(0, entry.due - this.now()),
    );
  }
  pause() {
    if (this.pausedAt !== undefined) return;
    this.pausedAt = Date.now();
    for (const entry of this.timers.values()) clearTimeout(entry.timer);
  }
  resume() {
    if (this.pausedAt === undefined) return;
    this.offset += Date.now() - this.pausedAt;
    this.pausedAt = undefined;
    for (const id of this.timers.keys()) this.schedule(id);
  }
}
