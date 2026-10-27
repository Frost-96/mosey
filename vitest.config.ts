import { defineConfig } from "vitest/config";
import HistoricalPackagedOrder from "./tests/support/sleep-ci-order.ts";
export default defineConfig({
  test: {
    maxWorkers: 1,
    sequence:
      process.env.MOSEY_HISTORICAL_CI_ORDER === "1"
        ? { sequencer: HistoricalPackagedOrder }
        : undefined,
    fileParallelism: false,
    projects: ["development", "packaged"].map((name) => ({
      test: {
        name,
        include: ["tests/*.test.ts"],
        env: { MOSEY_TEST_MODE: name },
        testTimeout: 90000,
        hookTimeout: 90000,
        fileParallelism: false,
      },
    })),
  },
});
