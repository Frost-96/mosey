import { defineConfig } from "vitest/config";

export function applicationProject(
  mode: "development" | "packaged",
  scale?: "1" | "2",
) {
  return {
    test: {
      name: scale ? `${mode}-${scale}x` : mode,
      include: ["tests/*.test.ts"],
      exclude: ["tests/pixel-comparison.test.ts"],
      env: {
        MOSEY_TEST_MODE: mode,
        ...(scale ? { MOSEY_TEST_SCALE_FACTOR: scale } : {}),
      },
      testTimeout: 90000,
      hookTimeout: 90000,
      fileParallelism: false,
    },
  };
}

export default defineConfig({
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    projects: [
      applicationProject("development"),
      applicationProject("packaged"),
      {
        test: {
          name: "deterministic",
          include: ["tests/pixel-comparison.test.ts"],
        },
      },
    ],
  },
});
