import { ControlledBehaviorAdapter } from "../../src/behavior/adapters";

export type ControlledBehaviorOptions = {
  random?: number;
  running?: boolean;
};
export type BehaviorInput = ControlledBehaviorOptions & { advanceBy?: number };

// This module is bundled only into an identified, scenario-owned test build.
// Infrastructure timers and the renderer keep their untouched wall clocks.
export function createBehaviorController(options: ControlledBehaviorOptions) {
  let random = options.random ?? 0.1;
  let running = options.running ?? true;
  let previous = performance.now();
  const adapter = new ControlledBehaviorAdapter({ random: () => random });
  const pump = () => {
    const current = performance.now();
    const elapsed = current - previous;
    previous = current;
    if (running) adapter.advanceBy(elapsed);
  };
  const update = (input: BehaviorInput) => {
    pump();
    if (input.random !== undefined) {
      if (
        !Number.isFinite(input.random) ||
        input.random < 0 ||
        input.random >= 1
      )
        throw new RangeError("Behavior choice must be in [0, 1)");
      random = input.random;
    }
    if (input.running !== undefined) running = input.running;
    if (input.advanceBy !== undefined) adapter.advanceBy(input.advanceBy);
  };
  const interval = setInterval(pump, 8);
  interval.unref();
  // Inspector input exists only in this owned derivative, never shipped code.
  // Expose no actor, timeline, snapshot or private production state.
  Reflect.set(globalThis, Symbol.for("mosey.test.behavior"), { update });
  return { adapter };
}
