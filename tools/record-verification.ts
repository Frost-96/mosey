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
  !["static", "deterministic", "development", "package", "packaged"].includes(
    channel,
  )
)
  throw new Error(
    "MOSEY_VERIFICATION_CHANNEL must identify a verification channel",
  );
const status = process.env.MOSEY_VERIFICATION_STATUS;
if (!status || !["success", "failure", "cancelled", "skipped"].includes(status))
  throw new Error("MOSEY_VERIFICATION_STATUS must be the actual job status");
const application = channel === "development" || channel === "packaged";
const requestedScale = application
  ? Number(process.env.MOSEY_TEST_SCALE_FACTOR)
  : null;
if (application && requestedScale !== 1 && requestedScale !== 2)
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
if (application)
  for (const file of globSync(
    `test-results/pet-sessions/${channel}-*/progress.jsonl`,
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
  mode: application ? channel : null,
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
  scenarioFiles:
    application || channel === "deterministic" ? scenarioFiles(channel) : [],
  scaleCoverage: application ? scaleCoverage : null,
  observedScaleEvidence,
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
        `Observed DPR evidence: ${observedScaleEvidence.length} recorded launch(es); this does not establish coverage for unrecorded launches.`,
        scaleCoverage.limitation,
        "",
      ]
    : []),
  "The recorded status precedes evidence upload. GitHub's job conclusion is authoritative, including if cancellation prevents finalization or upload. Artifacts retain the inventory, test results and available session evidence.",
  "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
