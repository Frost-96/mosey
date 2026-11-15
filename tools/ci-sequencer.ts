import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { balance } from "./balance-ci.ts";
import durations from "./ci-test-durations.json" with { type: "json" };

// Per-module medians from successful runs 42976782236, 42984240935,
// 42991689910, 42994400432, 42999839958, 43014370138 and 43021158982.
// Skipped modules retain zero weight.
// Seconds are scheduling hints only; no validation depends on these values.
const weights: Record<string, Record<string, number>> = durations;

// CI runs each shard in two phases (development, then packaged) so that four
// shards can start testing while shard 1 packages the application. Both phases
// must derive one partition of the complete mode/scale inventory, so the
// partition never depends on which projects the current phase loaded.
export const ciProjects = [
  "development-1x",
  "development-2x",
  "packaged-1x",
  "packaged-2x",
] as const;
// Shard 1 packages and uploads the application before its first test; the
// other shards download it between phases. The difference is reserved here.
export const packagingSeconds = 30;

export class BalancedSequencer extends BaseSequencer {
  async shard(files: TestSpecification[]) {
    const { count, index } = this.ctx.config.shard!;
    const relative = (file: TestSpecification) =>
      path.relative(this.ctx.config.root, file.moduleId);
    const modules = [...new Set(files.map(relative))].sort();
    const inventory = ciProjects.flatMap((project) =>
      modules.map((file) => ({ project, file })),
    );
    const identity = (item: { project: string; file: string }) =>
      `${item.project}/${item.file}`;
    const assigned = new Set(
      balance(
        inventory,
        count,
        (item) => weights[item.project]?.[path.basename(item.file)] ?? 60,
        identity,
        [packagingSeconds],
      )[index - 1]!.map(identity),
    );
    return files.filter((file) =>
      assigned.has(`${file.project.name}/${relative(file)}`),
    );
  }
}
