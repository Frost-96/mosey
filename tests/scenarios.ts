import { readdirSync } from "node:fs";
import path from "node:path";

// Every test file belongs to exactly one group. Test titles never select coverage.
// Application groups deliberately run in both modes; scale-independent checks
// run once. Keep conditional native/development cases inside their test files.
export const scenarioGroups = {
  observationHarness: ["tests/observation-lifecycle.test.ts"],
  packagePreparation: [
    "tests/login-preparation.test.ts",
    "tests/preparation-package.test.ts",
    "tests/preparation-package-build.test.ts",
  ],
  preparation: [
    "tests/preparation-session.test.ts",
    "tests/preparation-build.test.ts",
    "tests/preparation-derivatives.test.ts",
    "tests/preparation-ownership.test.ts",
    "tests/preparation-parallel.test.ts",
  ],
  deterministic: [
    "tests/behavior-time.test.ts",
    "tests/behavior-build.test.ts",
    "tests/pixel-comparison.test.ts",
    "tests/verification-report.test.ts",
    "tests/verification-inventory.test.ts",
  ],
  application: [
    "tests/app.test.ts",
    "tests/autonomy.test.ts",
    "tests/behavior-control.test.ts",
    "tests/character-sample.test.ts",
    "tests/character-switch.test.ts",
    "tests/context-menu.test.ts",
    "tests/dock-recovery.test.ts",
    "tests/dock-producer.test.ts",
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
  lifecycleHarness: [
    "tests/session-exit-lifecycle.test.ts",
    "tests/session-quit-dispatch.test.ts",
    "tests/session-renderer-dispatch.test.ts",
    "tests/settings-readiness-lifecycle.test.ts",
    "tests/behavior-input-lifecycle.test.ts",
  ],
};

export const testProjects = {
  deterministic: { mode: "deterministic", files: scenarioGroups.deterministic },
  development: { mode: "development", files: scenarioGroups.application },
  packaged: {
    mode: "packaged",
    files: [...scenarioGroups.application, ...scenarioGroups.packagedOnly],
  },
  preparation: { mode: "development", files: scenarioGroups.preparation },
  "preparation-packaged": {
    mode: "packaged",
    files: scenarioGroups.packagePreparation,
  },
  "lifecycle-development": {
    mode: "development",
    files: scenarioGroups.lifecycleHarness,
  },
  "lifecycle-packaged": {
    mode: "packaged",
    files: scenarioGroups.lifecycleHarness,
  },
  "observation-packaged": {
    mode: "packaged",
    files: scenarioGroups.observationHarness,
  },
} satisfies Record<
  string,
  { mode: "deterministic" | "development" | "packaged"; files: string[] }
>;

export type TestProject = keyof typeof testProjects;
export const testProjectNames = Object.keys(testProjects) as TestProject[];

export function scenarioFiles(project: TestProject): string[] {
  return testProjects[project].files;
}

// The matrix is a request, not evidence that every application reached observed DPR.
// geometry.test.ts also deliberately runs its authored-lettering fixture at 2x
// in either matrix entry. Per-test assertions/session logs remain the evidence.
export const scaleCoverage = {
  requested: [1, 2],
  matrixProvesObservedDpr: false,
  exceptions: [
    {
      file: "tests/app.test.ts",
      tests: [
        "packaged app starts a renderer without an inspector bootstrap",
        "cancelling an uninstrumented startup reaps its owned process before releasing the package",
      ],
      project: "packaged",
      requestedScale: 1,
      coverage: "scale-independent startup and cancellation; no DPR claim",
      reason:
        "An inspector would change the shipped uninstrumented startup premise. Run once in the packaged 1x entry.",
      evidence: "test-results/pet-sessions/*/startup.jsonl",
    },
  ],
  evidence:
    "Per-test assertions and test-results/pet-sessions/*/progress.jsonl",
  limitation:
    "Every ready inspector session asserts its requested DPR; the geometry authored-lettering fixture explicitly requests fixed 2x. No-inspector startup does not observe DPR. Lifecycle or native preparation cancellation before readiness cannot observe DPR. Native display scale is distinct from renderer DPR.",
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
  const scheduled = testProjectNames.flatMap(scenarioFiles);
  const unassigned = assignments.filter((file) => !scheduled.includes(file));
  const coverage = new Set<string>();
  const duplicateCoverage: { mode: string; file: string }[] = [];
  for (const { mode, files } of Object.values(testProjects)) {
    for (const file of files) {
      const key = `${mode}:${file}`;
      if (coverage.has(key)) duplicateCoverage.push({ mode, file });
      coverage.add(key);
    }
  }
  if (
    duplicates.length ||
    missing.length ||
    stale.length ||
    unassigned.length ||
    duplicateCoverage.length
  )
    throw new Error(
      `Invalid scenario inventory: ${JSON.stringify({ duplicates, missing, stale, unassigned, duplicateCoverage })}`,
    );
}
