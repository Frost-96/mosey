import type { TestProject } from "vitest/node";
import { createPreparationRun } from "./preparation";

export default async function setup(project: TestProject) {
  if (process.env.MOSEY_MEASUREMENT_KIND === "collection") return;
  const owner = await createPreparationRun();
  project.provide("moseyPreparation", owner.locator);
  return () => owner.close();
}
