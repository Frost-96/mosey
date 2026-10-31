import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stagePackagePreparation } from "./package-preparation.ts";
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
let finish: ReturnType<typeof beginMeasurement> | undefined;
let producer: Awaited<ReturnType<typeof stagePackagePreparation>> | undefined;
recordMeasurement("command", { executable, args });
let outcome: "passed" | "failed" | "cancelled";
let failure: unknown;
try {
  if (kind === "package") {
    if (executable !== "pnpm" || args.length !== 1 || args[0] !== "package:mac")
      throw new Error(
        "Package provenance requires the genuine pnpm package:mac entry",
      );
    producer = await stagePackagePreparation(process.cwd(), preparationId!);
  }
  finish = beginMeasurement(
    kind === "package" ? "package.prepare" : `command.${kind}`,
    { preparationId },
  );
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
      env: process.env,
      cwd: producer?.cwd,
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
    await producer!.publish();
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
  finish?.("failed", error);
  failure = error;
}
const cleanup = await producer?.close().then(
  () => undefined,
  (error: unknown) => ({ error }),
);
if (cleanup) {
  outcome = "failed";
  process.exitCode = 1;
  failure =
    failure === undefined
      ? cleanup.error
      : new AggregateError(
          [failure, cleanup.error],
          "Package preparation and cleanup failed",
          { cause: failure },
        );
}
finishWall(outcome);
summarizeMeasurements();
if (failure !== undefined) throw failure;
