import { defineConfig } from "vitest/config";
import { applicationProject } from "./vitest.config.ts";
import { BalancedSequencer } from "./tools/ci-sequencer.ts";
import { MatrixReporter } from "./tools/ci-reporter.ts";

// Each machine still owns one serial desktop. Spread all four validation
// channels across five machines, rather than queueing a second wave of jobs.
// CI runs every shard twice: MOSEY_CI_PHASE=development while shard 1 packages
// the application, then MOSEY_CI_PHASE=packaged once the package is present.
// Without a phase, both modes run in one invocation (local use).
const phase = process.env.MOSEY_CI_PHASE;
if (phase !== undefined && phase !== "development" && phase !== "packaged")
  throw new Error(`Unknown MOSEY_CI_PHASE: ${phase}`);
const modes: ("development" | "packaged")[] = phase
  ? [phase]
  : ["development", "packaged"];

export default defineConfig({
  test: {
    // Share development preparation, while each test owns its app and profile.
    globalSetup: ["./tests/support/ci-forge.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    bail: 0,
    projects: modes.flatMap((mode) =>
      (["1", "2"] as const).map((scale) => applicationProject(mode, scale)),
    ),
    sequence: { sequencer: BalancedSequencer },
    reporters: [
      "default",
      new MatrixReporter(
        `test-results/ci-matrix${phase ? `-${phase}` : ""}.json`,
      ),
    ],
  },
});
