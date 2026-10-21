import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    maxWorkers: 1,
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
