import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test } from "vitest";

const run = promisify(execFile);
const reporter = path.resolve("tools/record-verification.ts");

test.each([
  {
    name: "test report",
    file: "test-results/verification/tests.json",
    content: '{"testResults": [',
    metadata: undefined,
  },
  {
    name: "measurement metadata",
    file: "test-results/measurements/interrupted/run.json",
    content: '{"runId":',
    metadata: undefined,
  },
  {
    name: "measurement events",
    file: "test-results/measurements/interrupted/events.jsonl",
    content: '{"event": "start",',
    metadata: { runId: "interrupted", kind: "test" },
  },
])(
  "a cancelled channel retains its result when $name is truncated",
  async ({ file, content, metadata }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mosey-verification-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, "test-results/verification");
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
    if (metadata)
      await writeFile(
        path.join(root, "test-results/measurements/interrupted/run.json"),
        JSON.stringify(metadata),
      );

    await run(process.execPath, [reporter], {
      cwd: root,
      env: {
        ...process.env,
        GIT_DIR: execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
          encoding: "utf8",
        }).trim(),
        GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
        MOSEY_VERIFICATION_CHANNEL: "development",
        MOSEY_VERIFICATION_STATUS: "cancelled",
        MOSEY_TEST_SCALE_FACTOR: "2",
        MOSEY_VERIFICATION_STEPS: JSON.stringify({
          verification: { outcome: "cancelled", conclusion: "cancelled" },
        }),
      },
    });

    const record = JSON.parse(
      await readFile(path.join(directory, "record.json"), "utf8"),
    );
    expect(record).toMatchObject({
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      channel: "development",
      mode: "development",
      statusAtRecord: "cancelled",
      requestedScale: 2,
      steps: {
        verification: { outcome: "cancelled", conclusion: "cancelled" },
      },
      scenarioDurations: [],
      observedScaleEvidence: [],
      evidenceReadErrors: [
        {
          file: file.includes("measurements")
            ? "test-results/measurements/interrupted/run.json"
            : file,
          error: expect.stringContaining("SyntaxError"),
        },
      ],
    });
    expect(await readFile(path.join(root, "summary.md"), "utf8")).toContain(
      record.evidenceReadErrors[0].file,
    );
    expect(await readFile(path.join(root, file), "utf8")).toBe(content);
    if (metadata)
      expect(record.measurements).toEqual([
        {
          file: "test-results/measurements/interrupted/run.json",
          summary: null,
        },
      ]);
  },
);
