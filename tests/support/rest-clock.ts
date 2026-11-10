import type { ElectronApplication, Page } from "playwright";
import { autonomy } from "../../src/behavior/pet-machine.ts";

export async function controlRest(
  app: ElectronApplication,
  pet: Page,
  milliseconds: number,
) {
  const idleCycle = await pet.evaluate(async () =>
    (await window.mosey.getCharacter()).atlases
      .find((atlas) => atlas.action === "resting")!
      .frames.reduce((sum, frame) => sum + frame.durationMs, 0),
  );
  return app.evaluateHandle(installRestClock, {
    milliseconds,
    minimum: autonomy.restMinMs,
    maximum: autonomy.restMinMs + autonomy.restVariationMs + idleCycle,
  });
}

// This function is also serialized into the application's main process.
// Keep it self-contained: the caller supplies the active character's rest range.
export function installRestClock(
  _electron: unknown,
  options: { milliseconds: number; minimum: number; maximum: number },
) {
  const original = globalThis.setTimeout;
  const control = {
    milliseconds: options.milliseconds,
    restore() {
      globalThis.setTimeout = original;
    },
  };
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) =>
    original(
      callback,
      delay !== undefined &&
        delay >= options.minimum &&
        delay <= options.maximum
        ? control.milliseconds
        : delay,
      ...args,
    )) as typeof setTimeout;
  return control;
}
