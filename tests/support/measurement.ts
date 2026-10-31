import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

export type MeasurementContext = {
  sessionId?: string;
  preparationId?: string;
  test?: string;
  operation?: string;
};
type Outcome = "passed" | "failed" | "cancelled";
const context = new AsyncLocalStorage<MeasurementContext>();

export function measurementDirectory() {
  const runId = process.env.MOSEY_MEASUREMENT_RUN_ID;
  if (!runId) return undefined;
  return path.join(
    process.env.MOSEY_MEASUREMENT_ROOT ??
      path.resolve("test-results/measurements"),
    runId.replace(/[^\w-]/g, "_"),
  );
}

export function recordMeasurement(event: string, detail: object) {
  const directory = measurementDirectory();
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  appendFileSync(
    path.join(directory, "events.jsonl"),
    JSON.stringify({
      event,
      runId: process.env.MOSEY_MEASUREMENT_RUN_ID,
      kind: process.env.MOSEY_MEASUREMENT_KIND,
      mode: process.env.MOSEY_TEST_MODE,
      requestedScale: process.env.MOSEY_TEST_SCALE_FACTOR,
      pid: process.pid,
      at: new Date().toISOString(),
      ...context.getStore(),
      ...detail,
    }) + "\n",
  );
}

// Durations use this process's monotonic clock. Nested spans describe separate
// boundaries; their durations must not be summed as elapsed run time.
export function beginMeasurement(
  phase: string,
  detail: MeasurementContext = {},
) {
  const fields = {
    ...context.getStore(),
    ...detail,
    phase,
    spanId: randomUUID(),
  };
  const started = performance.now();
  recordMeasurement("start", fields);
  let finished = false;
  return (outcome: Outcome, error?: unknown) => {
    if (finished) return;
    finished = true;
    recordMeasurement("end", {
      ...fields,
      outcome,
      durationMs: performance.now() - started,
      ...(error === undefined ? {} : { error: String(error) }),
    });
  };
}

export async function measure<T>(
  phase: string,
  detail: MeasurementContext,
  action: () => Promise<T>,
): Promise<T> {
  return context.run({ ...context.getStore(), ...detail }, async () => {
    const finish = beginMeasurement(phase);
    try {
      const result = await action();
      finish("passed");
      return result;
    } catch (error) {
      finish("failed", error);
      throw error;
    }
  });
}

export function measureSync<T>(phase: string, action: () => T): T {
  const finish = beginMeasurement(phase);
  try {
    const value = action();
    finish("passed");
    return value;
  } catch (error) {
    finish("failed", error);
    throw error;
  }
}

export function initializeMeasurementRun() {
  const directory = measurementDirectory();
  if (!directory || existsSync(path.join(directory, "run.json"))) return;
  mkdirSync(directory, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", timeout: 5000 }).trim();
  const digest = (bytes: string | Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  const observe = (command: string, args: string[]) => {
    try {
      return execFileSync(command, args, {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      return null;
    }
  };
  writeFileSync(
    path.join(directory, "run.json"),
    JSON.stringify(
      {
        schema: 1,
        runId: process.env.MOSEY_MEASUREMENT_RUN_ID,
        kind: process.env.MOSEY_MEASUREMENT_KIND,
        commit: git("rev-parse", "HEAD"),
        tree: git("rev-parse", "HEAD^{tree}"),
        trackedDiffSHA256: digest(git("diff", "HEAD", "--")),
        lockSHA256: digest(readFileSync("pnpm-lock.yaml")),
        node: process.versions.node,
        pnpm: observe("pnpm", ["--version"]),
        installedVersions: Object.fromEntries(
          [
            "electron",
            "@electron-forge/cli",
            "vite",
            "vitest",
            "typescript",
            "sharp",
            "@electron/asar",
          ].map((name) => [
            name,
            JSON.parse(
              readFileSync(
                path.join("node_modules", name, "package.json"),
                "utf8",
              ),
            ).version,
          ]),
        ),
        platform: process.platform,
        architecture: process.arch,
        osRelease: os.release(),
        nativeToolchain:
          process.platform === "darwin"
            ? {
                developerDirectory: observe("/usr/bin/xcode-select", ["-p"]),
                swift: observe("/usr/bin/xcrun", ["swiftc", "--version"]),
                sdk: observe("/usr/bin/xcrun", [
                  "--sdk",
                  "macosx",
                  "--show-sdk-path",
                ]),
                sdkVersion: observe("/usr/bin/xcrun", [
                  "--sdk",
                  "macosx",
                  "--show-sdk-version",
                ]),
                role: "Command host; a packaged test host is the consumer, not the package producer.",
              }
            : null,
        cachesPresentAtStart: Object.fromEntries(
          [".vite", "node_modules/.vite", "build/swift-module-cache"].map(
            (directory) => [directory, existsSync(directory)],
          ),
        ),
        environment: Object.fromEntries(
          [
            "CI",
            "MOSEY_VERIFICATION_CHANNEL",
            "MOSEY_TEST_MODE",
            "MOSEY_TEST_SCALE_FACTOR",
            "MOSEY_TEST_CHARACTER",
            "MOSEY_RECORD_SAMPLE",
            "DEVELOPER_DIR",
            "SDKROOT",
            "MACOSX_DEPLOYMENT_TARGET",
          ].map((key) => [key, process.env[key] ?? null]),
        ),
        identityScope:
          "Measurement provenance only; not a validated preparation-input manifest or cache key.",
      },
      null,
      2,
    ) + "\n",
  );
}

export function summarizeMeasurements(directory = measurementDirectory()) {
  if (!directory) return;
  const run = JSON.parse(
    readFileSync(path.join(directory, "run.json"), "utf8"),
  ) as {
    runId: string;
    kind: string;
  };
  const file = path.join(directory, "events.jsonl");
  const rows = existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const phases: Record<
    string,
    {
      attempts: number;
      passed: number;
      failed: number;
      cancelled: number;
      completedDurationMs: number;
      incomplete: number;
    }
  > = {};
  const pending = new Set<string>();
  for (const row of rows) {
    if (row.event !== "start" && row.event !== "end") continue;
    const phase = (phases[row.phase] ??= {
      attempts: 0,
      passed: 0,
      failed: 0,
      cancelled: 0,
      completedDurationMs: 0,
      incomplete: 0,
    });
    if (row.event === "start") {
      phase.attempts++;
      phase.incomplete++;
      pending.add(row.spanId);
    } else if (pending.delete(row.spanId)) {
      phase.incomplete--;
      phase[row.outcome as Outcome]++;
      phase.completedDurationMs += row.durationMs;
    }
  }
  const summary = {
    runId: run.runId,
    kind: run.kind,
    phases,
    incompleteSpanIds: [...pending],
    preparationAttempts: Object.fromEntries(
      [
        "forge.prepare",
        "package.prepare",
        "session.copy",
        "behavior.controller-build",
        "native.fixture-compile",
      ].map((phase) => [phase, phases[phase]?.attempts ?? 0]),
    ),
    durationScope:
      "Nested spans overlap; never sum them into run wall time. Missing ends remain incomplete, not passed.",
  };
  writeFileSync(
    path.join(directory, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  return summary;
}
