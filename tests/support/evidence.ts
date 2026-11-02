import { mkdirSync } from "node:fs";
import path from "node:path";

// Keep a late failure/cleanup callback associated with its originating project.
const mode = process.env.MOSEY_TEST_MODE;
const scale = process.env.MOSEY_TEST_SCALE_FACTOR ?? "1";
const directory = path.resolve("test-results", `${mode}-${scale}x`);

// A shard can run both scales of the same mode. Namespace every application
// artifact before writing it; separate upload names cannot prevent overwrites.
export function evidencePath(...parts: string[]) {
  if (mode !== "development" && mode !== "packaged")
    throw new Error("Application evidence requires a test mode");
  mkdirSync(directory, { recursive: true });
  return path.join(directory, ...parts);
}
