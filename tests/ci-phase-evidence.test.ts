import { expect, it } from "vitest";

// Deliberate failure for #141's evidence run. Delete after the run.
it("fails only in development mode", () => {
  expect(process.env.MOSEY_TEST_MODE).toBe("packaged");
});
