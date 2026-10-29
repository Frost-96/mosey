import { readdirSync } from "node:fs";
import path from "node:path";

// Every test file belongs to exactly one group. Test titles never select coverage.
// Application groups deliberately run in both modes; scale-independent checks
// run once. Keep conditional native/development cases inside their test files.
export const scenarioGroups = {
  deterministic: [
    "tests/behavior-time.test.ts",
    "tests/behavior-build.test.ts",
    "tests/pixel-comparison.test.ts",
  ],
  application: [
    "tests/app.test.ts",
    "tests/autonomy.test.ts",
    "tests/behavior-control.test.ts",
    "tests/character-sample.test.ts",
    "tests/character-switch.test.ts",
    "tests/context-menu.test.ts",
    "tests/dock-recovery.test.ts",
    "tests/dock-status.test.ts",
    "tests/dock.test.ts",
    "tests/geometry.test.ts",
    "tests/ground-recovery.test.ts",
    "tests/menu-reentry.test.ts",
    "tests/renderer-recovery.test.ts",
    "tests/session-lifecycle.test.ts",
    "tests/settings-login.test.ts",
    "tests/settings-readiness.test.ts",
    "tests/settings-state.test.ts",
    "tests/settings.test.ts",
    "tests/size-autonomy.test.ts",
    "tests/size.test.ts",
    "tests/sleep.test.ts",
    "tests/slider.test.ts",
    "tests/visibility.test.ts",
  ],
  packagedOnly: ["tests/login-items.test.ts"],
};

export type TestProject = "deterministic" | "development" | "packaged";

export function scenarioFiles(project: TestProject): string[] {
  if (project === "deterministic") return scenarioGroups.deterministic;
  return [
    ...scenarioGroups.application,
    ...(project === "packaged" ? scenarioGroups.packagedOnly : []),
  ];
}

// The matrix is a request, not evidence that every legacy launch observed DPR.
// geometry.test.ts also deliberately runs its authored-lettering fixture at 2x
// in either matrix entry. Per-test assertions/session logs remain the evidence.
export const scaleCoverage = {
  requested: [1, 2],
  matrixProvesObservedDpr: false,
  evidence:
    "Per-test assertions and test-results/pet-sessions/*/progress.jsonl",
  limitation:
    "Legacy launches do not all request and assert DPR; the geometry authored-lettering fixture uses fixed 2x. Lifecycle cancellation before readiness cannot observe DPR. Native display scale is distinct from renderer DPR.",
};

export function validateScenarioInventory(root = process.cwd()) {
  const assignments = Object.values(scenarioGroups).flat();
  const discovered = readdirSync(path.join(root, "tests"), { recursive: true })
    .filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(String(file)))
    .map((file) => `tests/${String(file).split(path.sep).join("/")}`);
  const duplicates = assignments.filter(
    (file, index) => assignments.indexOf(file) !== index,
  );
  const missing = discovered.filter((file) => !assignments.includes(file));
  const stale = assignments.filter((file) => !discovered.includes(file));
  if (duplicates.length || missing.length || stale.length)
    throw new Error(
      `Invalid scenario inventory: ${JSON.stringify({ duplicates, missing, stale })}`,
    );
}
