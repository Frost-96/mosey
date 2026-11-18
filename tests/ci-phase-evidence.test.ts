import { expect, test } from "vitest";

// Deliberate failure for #141's evidence run. Delete after the run.
test("fails only in development mode", () => {
  expect(process.env.MOSEY_TEST_MODE).toBe("packaged");
});
