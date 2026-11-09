import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { balance } from "./balance-ci.ts";
import durations from "./ci-test-durations.json" with { type: "json" };

// Per-module medians from successful runs 42602134379 and 42625052903
// (attempt 2). Skipped modules retain zero weight.
// Seconds are scheduling hints only; no validation depends on these values.
const weights: Record<string, Record<string, number>> = durations;

export class BalancedSequencer extends BaseSequencer {
  async shard(files: TestSpecification[]) {
    const { count, index } = this.ctx.config.shard!;
    return balance(
      files,
      count,
      (file) =>
        weights[file.project.name]?.[path.basename(file.moduleId)] ?? 60,
      (file) =>
        `${file.project.name}/${path.relative(this.ctx.config.root, file.moduleId)}`,
    )[index - 1]!;
  }
}
