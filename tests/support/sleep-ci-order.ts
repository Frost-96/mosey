import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// Preserve the file ordering observed in main run 40511484192. Diagnostic
// additions must not reorder a cold run through Vitest's file-size fallback.
const order = [
  "tests/dock.test.ts",
  "tests/app.test.ts",
  "tests/dock-recovery.test.ts",
  "tests/character-switch.test.ts",
  "tests/size-autonomy.test.ts",
  "tests/context-menu.test.ts",
  "tests/autonomy.test.ts",
  "tests/renderer-recovery.test.ts",
  "tests/sleep.test.ts",
  "tests/size.test.ts",
  "tests/settings.test.ts",
  "tests/settings-state.test.ts",
  "tests/visibility.test.ts",
  "tests/settings-login.test.ts",
  "tests/slider.test.ts",
  "tests/character-sample.test.ts",
  "tests/login-items.test.ts",
  "tests/menu-reentry.test.ts",
  "tests/dock-status.test.ts",
  "tests/ground-recovery.test.ts",
  "tests/settings-readiness.test.ts",
];
export default class HistoricalPackagedOrder extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return [...files].sort(
      (a, b) =>
        order.indexOf(path.relative(process.cwd(), a.moduleId)) -
        order.indexOf(path.relative(process.cwd(), b.moduleId)),
    );
  }
}
