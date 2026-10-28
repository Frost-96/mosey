import { defineConfig } from "vitest/config";
import {
  scenarioFiles,
  validateScenarioInventory,
  type TestProject,
} from "./tests/scenarios.ts";

validateScenarioInventory();

const projects: TestProject[] = ["deterministic", "development", "packaged"];

export default defineConfig({
  test: {
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
