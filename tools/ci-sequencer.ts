import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { balance } from "./balance-ci.ts";
import durations from "./ci-test-durations.json" with { type: "json" };

// Measured with shared preparation, run 42597781285. The interrupted
// packaged-1x context-menu module uses the slowest successful channel's time.
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
