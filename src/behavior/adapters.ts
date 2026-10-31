// Behavior time and choices belong to one pet. Infrastructure deadlines keep
// using their own wall clock and are never advanced by a behavior adapter.
export type BehaviorAdapter = {
  now(): number;
  random(): number;
  // Renderer timestamps remain wall epochs even when behavior time is virtual.
  toWallTime(time: number): number;
  schedule(callback: () => void, delay: number): () => void;
};

export const realBehaviorAdapter: BehaviorAdapter = {
  now: () => Date.now(),
  random: () => Math.random(),
  toWallTime: (time) => time,
  schedule: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

export class ControlledBehaviorAdapter implements BehaviorAdapter {
  private time = 0;
  private nextId = 0;
  private readonly scheduled = new Map<
    number,
    { due: number; callback: () => void }
  >();

  constructor(private readonly choices: { random: () => number }) {}

  now = () => this.time;
  random = () => this.choices.random();
  toWallTime = (time: number) => Date.now() - (this.time - time);
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.scheduled.set(id, { callback, due: this.time + Math.max(0, delay) });
    return () => {
      this.scheduled.delete(id);
    };
  };

  // Run each elapsed behavior deadline at its due time, including deadlines
  // created by an earlier transition within this advance.
  advanceBy(duration: number) {
    if (!Number.isFinite(duration) || duration < 0)
      throw new RangeError("Behavior time must advance by a finite duration");
    const until = this.time + duration;
    for (;;) {
      const next = [...this.scheduled].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > until) break;
      const [id, { due, callback }] = next;
      this.time = due;
      this.scheduled.delete(id);
      callback();
    }
    this.time = until;
  }
}
