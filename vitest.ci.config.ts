import { defineConfig } from "vitest/config";
import { applicationProject } from "./vitest.config.ts";
import { BalancedSequencer } from "./tools/ci-sequencer.ts";
import { MatrixReporter } from "./tools/ci-reporter.ts";

// Each machine still owns one serial desktop. Spread all four validation
// channels across five machines, rather than queueing a second wave of jobs.
const modes: ("development" | "packaged")[] =
  process.env.MOSEY_CI_PACKAGE_READY === "false"
    ? ["development"]
    : ["development", "packaged"];

export default defineConfig({
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    bail: 0,
    projects: modes.flatMap((mode) =>
      (["1", "2"] as const).map((scale) => applicationProject(mode, scale)),
    ),
    sequence: { sequencer: BalancedSequencer },
    reporters: ["default", new MatrixReporter()],
  },
});
