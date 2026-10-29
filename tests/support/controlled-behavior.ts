import { expect } from "vitest";
import { observePetRenderer } from "./pet-renderer";
import type { ElectronApplication } from "playwright";
import { autonomy } from "../../src/behavior/pet-machine";
import type { BehaviorInput } from "./behavior-controller";

export function controlBehavior(
  app: ElectronApplication,
  input: BehaviorInput,
) {
  return app.evaluate((_electron, input) => {
    const controller = Reflect.get(
      globalThis,
      Symbol.for("mosey.test.behavior"),
    );
    if (!controller)
      throw new Error("Application is not a controlled behavior build");
    controller.update(input);
  }, input);
}

// Input setup, never an outcome oracle. Call after ordinary hide/show scheduled
// a rest with this same choice. Product timing is centralized at its own seam.
export async function advanceRest(
  app: ElectronApplication,
  choice: number,
  run: <T>(label: string, action: () => Promise<T>) => Promise<T> = (
    _label,
    action,
  ) => action(),
) {
  const renderer = observePetRenderer(app);
  await expect
    .poll(
      async () =>
        (await run("rest-presentation", renderer.read))?.presentation.posture,
      {
        timeout: 5000,
      },
    )
    .toBe("resting");
  return run("advance-rest-input", () =>
    controlBehavior(app, {
      advanceBy: autonomy.restMinMs + choice * autonomy.restVariationMs,
    }),
  );
}
