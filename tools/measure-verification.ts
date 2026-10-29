import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  beginMeasurement,
  initializeMeasurementRun,
  recordMeasurement,
  summarizeMeasurements,
} from "../tests/support/measurement.ts";

const [kind, executable, ...args] = process.argv.slice(2);
if (!kind || !["collection", "test", "package"].includes(kind) || !executable)
  throw new Error(
    "Usage: measure-verification.ts collection|test|package command [args...]",
  );
process.env.MOSEY_MEASUREMENT_RUN_ID = randomUUID();
process.env.MOSEY_MEASUREMENT_ROOT = path.resolve("test-results/measurements");
process.env.MOSEY_MEASUREMENT_KIND = kind;
const finishWall = beginMeasurement("verification.wall");
initializeMeasurementRun();
const preparationId = kind === "package" ? randomUUID() : undefined;
const finish = beginMeasurement(
  kind === "package" ? "package.prepare" : `command.${kind}`,
  { preparationId },
);
recordMeasurement("command", { executable, args });
let outcome: "passed" | "failed" | "cancelled" = "failed";
try {
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  outcome = result.signal
    ? "cancelled"
    : result.code === 0
      ? "passed"
      : "failed";
  finish(outcome);
  recordMeasurement("command-exited", result);
  if (kind === "package" && result.code === 0 && !result.signal) {
    const archive =
      "out/Mosey-darwin-arm64/Mosey.app/Contents/Resources/app.asar";
    const association = {
      runId: process.env.MOSEY_MEASUREMENT_RUN_ID,
      preparationId,
      artifactSHA256: createHash("sha256")
        .update(readFileSync(archive))
        .digest("hex"),
      scope: "Timing association only; not a validated package-input manifest.",
    };
    writeFileSync(
      "out/package-measurement.json",
      JSON.stringify(association, null, 2) + "\n",
    );
    recordMeasurement("package-artifact", association);
  }
  process.exitCode = result.code ?? 1;
} catch (error) {
  outcome = "failed";
  finish("failed", error);
  throw error;
} finally {
  finishWall(outcome);
  summarizeMeasurements();
}
