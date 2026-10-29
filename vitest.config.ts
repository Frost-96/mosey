import { defineConfig } from "vitest/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  scenarioFiles,
  validateScenarioInventory,
  type TestProject,
} from "./tests/scenarios.ts";

validateScenarioInventory();

const projects: TestProject[] = ["deterministic", "development", "packaged"];
process.env.MOSEY_MEASUREMENT_RUN_ID ??= randomUUID();
process.env.MOSEY_MEASUREMENT_ROOT ??= path.resolve(
  "test-results/measurements",
);
process.env.MOSEY_MEASUREMENT_KIND ??= process.argv.includes("list")
  ? "collection"
  : "test";

export default defineConfig({
  test: {
    globalSetup: ["./tests/support/measurement-setup.ts"],
    env: {
      MOSEY_MEASUREMENT_RUN_ID: process.env.MOSEY_MEASUREMENT_RUN_ID,
      MOSEY_MEASUREMENT_ROOT: process.env.MOSEY_MEASUREMENT_ROOT,
      MOSEY_MEASUREMENT_KIND: process.env.MOSEY_MEASUREMENT_KIND,
    },
    maxWorkers: 1,
    fileParallelism: false,
    projects: projects.map((name) => ({
      test: {
        name,
        include: scenarioFiles(name),
        env: { MOSEY_TEST_MODE: name },
        testTimeout: 90000,
        hookTimeout: 90000,
        fileParallelism: false,
      },
    })),
  },
});
