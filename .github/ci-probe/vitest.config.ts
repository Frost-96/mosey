import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      ".github/ci-probe/hidden.test.ts",
      "tests/renderer-recovery.test.ts",
    ],
    env: { MOSEY_TEST_MODE: "packaged" },
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 90000,
  },
});
