import {
  scenarioFiles,
  scaleCoverage,
  testProjectNames,
  validateScenarioInventory,
} from "../tests/scenarios.ts";

validateScenarioInventory();
console.log(
  JSON.stringify(
    {
      ...Object.fromEntries(
        testProjectNames.map((name) => [name, scenarioFiles(name)]),
      ),
      scaleCoverage,
    },
    null,
    2,
  ),
);
