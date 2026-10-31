import {
  beginMeasurement,
  initializeMeasurementRun,
  summarizeMeasurements,
} from "./measurement";

// Dynamic Vitest collection also enters globalSetup. This setup only records
// evidence; collection and execution retain their own run IDs and zero counts.
export default function setup() {
  initializeMeasurementRun();
  const finish = beginMeasurement("runner.lifetime");
  return () => {
    finish("passed");
    summarizeMeasurements();
  };
}
