import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  globSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { scenarioFiles, scaleCoverage } from "../tests/scenarios.ts";
import path from "node:path";
import { summarizeMeasurements } from "../tests/support/measurement.ts";

const channel = process.env.MOSEY_VERIFICATION_CHANNEL;
if (
  !channel ||
  ![
    "static",
    "deterministic",
    "development",
    "package",
    "packaged",
    "lifecycle-development",
    "lifecycle-packaged",
    "observation-packaged",
    "preparation",
    "preparation-packaged",
  ].includes(channel)
)
  throw new Error(
    "MOSEY_VERIFICATION_CHANNEL must identify a verification channel",
  );
const status = process.env.MOSEY_VERIFICATION_STATUS;
if (!status || !["success", "failure", "cancelled", "skipped"].includes(status))
  throw new Error("MOSEY_VERIFICATION_STATUS must be the actual job status");
const mode =
  channel === "development" ||
  channel === "lifecycle-development" ||
  channel === "preparation"
    ? "development"
    : channel === "packaged" ||
        channel === "lifecycle-packaged" ||
        channel === "observation-packaged" ||
        channel === "preparation-packaged"
      ? "packaged"
      : null;
const application = mode !== null;
const observationHarness = channel === "observation-packaged";
const lifecycleHarness =
  channel === "lifecycle-development" || channel === "lifecycle-packaged";
const project = (
  [
    "deterministic",
    "development",
    "packaged",
    "lifecycle-development",
    "lifecycle-packaged",
    "observation-packaged",
    "preparation",
    "preparation-packaged",
  ] as const
).find((name) => name === channel);
const requestedScale =
  application && !observationHarness
    ? Number(process.env.MOSEY_TEST_SCALE_FACTOR)
    : null;
if (
  application &&
  !observationHarness &&
  requestedScale !== 1 &&
  requestedScale !== 2
)
  throw new Error(
    "Application verification requires an explicit requested scale of 1 or 2",
  );
const steps = JSON.parse(
  process.env.MOSEY_VERIFICATION_STEPS ?? "{}",
) as Record<string, { outcome?: string; conclusion?: string }>;
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const observedScaleEvidence: {
  file: string;
  test?: string;
  requested: number;
  observed: number;
}[] = [];
const measurements = globSync("test-results/measurements/*/run.json").map(
  (file) => ({
    file,
    summary: summarizeMeasurements(path.dirname(file)),
  }),
);
const testReport = "test-results/verification/tests.json";
const scenarioDurations = existsSync(testReport)
  ? (
      JSON.parse(readFileSync(testReport, "utf8")).testResults as {
        name: string;
        assertionResults: {
          fullName: string;
          status: string;
          duration?: number;
        }[];
      }[]
    ).flatMap((file) =>
      file.assertionResults.map((test) => ({
        file: file.name,
        test: test.fullName,
        status: test.status,
        durationMs: test.duration ?? null,
      })),
    )
  : [];
const evidenceReadErrors: { file: string; error: string }[] = [];
if (application && !observationHarness)
  for (const file of globSync(
    `test-results/pet-sessions/${mode}-*/progress.jsonl`,
  )) {
    try {
      for (const line of readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)) {
        const entry = JSON.parse(line) as {
          event?: string;
          test?: string;
          detail?: { requested?: number; observed?: number };
        };
        if (
          entry.event === "observed-scale" &&
          typeof entry.detail?.requested === "number" &&
          typeof entry.detail.observed === "number"
        )
          observedScaleEvidence.push({
            file,
            test: entry.test,
            requested: entry.detail.requested,
            observed: entry.detail.observed,
          });
      }
    } catch (error) {
      evidenceReadErrors.push({ file, error: String(error) });
    }
  }
const unforcedScaleEvidence: {
  file: string;
  dpr: number;
  displays: { id: number; scaleFactor: number }[];
}[] = [];
if (observationHarness)
  for (const file of globSync(
    "test-results/observation-sessions/**/lifecycle.jsonl",
  )) {
    try {
      for (const line of readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)) {
        const entry = JSON.parse(line) as {
          event?: string;
          detail?: {
            dpr?: number;
            displays?: { id: number; scaleFactor: number }[];
          };
        };
        if (
          entry.event === "ready" &&
          typeof entry.detail?.dpr === "number" &&
          Array.isArray(entry.detail.displays)
        )
          unforcedScaleEvidence.push({
            file,
            dpr: entry.detail.dpr,
            displays: entry.detail.displays,
          });
      }
    } catch (error) {
      evidenceReadErrors.push({ file, error: String(error) });
    }
  }
const preparationHarness =
  channel === "preparation" || channel === "preparation-packaged";
const recordedScaleCoverage = observationHarness
  ? {
      requested: [],
      coverage:
        "Original-bundle observation ownership, cancellation and actual process exit; one unforced packaged run",
      reason:
        "The manual tools must preserve the supplied macOS bundle/permission identity and native scale; their adapter never copies, re-signs or forces DPR.",
      evidence:
        "Unforced DPR and native display scales in unforcedScaleEvidence; per-session lifecycle records distinguish exit zero from safety signals and preserve failures.",
      limitation:
        "Separate scale-independent harness using owned diagnostic identities; actual observed values do not establish 1x/2x matrix or real permission acceptance. Cancellation before readiness supplies no DPR observation.",
    }
  : preparationHarness
    ? {
        requested: [requestedScale],
        coverage:
          "Preparation identity, immutable inputs, ownership and failure isolation; one requested 1x CI run per mode",
        evidence:
          "Preparation receipts, real build/output assertions, process/HTTP lifecycle observations and any recorded renderer DPR.",
        limitation:
          "Preparation harness is separate from the frozen business matrix; it does not claim 2x or native-display-scale coverage.",
      }
    : lifecycleHarness
      ? {
          requested: [requestedScale],
          coverage:
            "scale-independent Quit and visibility input dispatch, renderer recovery, settings readiness cancellation and behavior input dispatch; one requested 1x CI run per mode",
          reason:
            "Driver scheduling, readiness cancellation and normal process exit do not depend on renderer DPR.",
          evidence:
            "Per-test DPR assertion and observedScaleEvidence from progress.jsonl.",
          limitation:
            "Lifecycle harness CI jobs exercise only 1x; they do not claim 2x or native-display-scale coverage.",
        }
      : application
        ? scaleCoverage
        : null;
const record = {
  commit,
  workflowCommit: process.env.GITHUB_SHA ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  runUrl:
    process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
  channel,
  mode,
  statusAtRecord: status,
  finalConclusion:
    "Use the GitHub job conclusion; this record precedes evidence upload.",
  requestedScale,
  preparationResult: process.env.MOSEY_PREPARATION_RESULT ?? null,
  steps: Object.fromEntries(
    Object.entries(steps).map(([name, step]) => [
      name,
      { outcome: step.outcome, conclusion: step.conclusion },
    ]),
  ),
  scenarioFiles: project ? scenarioFiles(project) : [],
  scaleCoverage: recordedScaleCoverage,
  observedScaleEvidence,
  unforcedScaleEvidence,
  measurements,
  scenarioDurations,
  evidenceReadErrors,
  recordedAt: new Date().toISOString(),
};
mkdirSync("test-results/verification", { recursive: true });
writeFileSync(
  "test-results/verification/record.json",
  JSON.stringify(record, null, 2) + "\n",
);
const summary = [
  `### ${channel}: ${status}`,
  "",
  `Commit: \`${commit}\``,
  `Requested scale: ${requestedScale === null ? "not applicable" : `${requestedScale}x`}`,
  `Preparation result: ${record.preparationResult ?? "not applicable"}`,
  "",
  "| Step | Outcome | Conclusion |",
  "| --- | --- | --- |",
  ...Object.entries(record.steps).map(
    ([name, step]) =>
      `| ${name} | ${step.outcome ?? "unknown"} | ${step.conclusion ?? "unknown"} |`,
  ),
  "",
  ...(application
    ? [
        observationHarness
          ? `Unforced scale evidence: ${unforcedScaleEvidence.length} recorded launch(es); no requested 1x/2x coverage claim.`
          : `Observed DPR evidence: ${observedScaleEvidence.length} recorded launch(es); this does not establish coverage for unrecorded launches.`,
        recordedScaleCoverage?.limitation,
        "",
      ]
    : []),
  "The recorded status precedes evidence upload. GitHub's job conclusion is authoritative, including if cancellation prevents finalization or upload. Artifacts retain the inventory, test results and available session evidence.",
  "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
