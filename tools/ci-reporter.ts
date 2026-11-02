import { mkdir, writeFile } from "node:fs/promises";
import type { Reporter, TestModule } from "vitest/node";

export class MatrixReporter implements Reporter {
  async onTestRunEnd(modules: readonly TestModule[]) {
    await mkdir("test-results", { recursive: true });
    await writeFile(
      "test-results/ci-matrix.json",
      JSON.stringify(
        modules.map((module) => ({
          project: module.project.name,
          file: module.relativeModuleId,
          state: module.state(),
          durationMs: module.diagnostic().duration,
          tests: [...module.children.allTests()].map((test) => ({
            name: test.fullName,
            state: test.result().state,
            durationMs: test.diagnostic()?.duration,
          })),
        })),
        null,
        2,
      ),
    );
  }
}
