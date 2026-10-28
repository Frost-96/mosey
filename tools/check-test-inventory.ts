import {
  scenarioFiles,
  scaleCoverage,
  validateScenarioInventory,
} from "../tests/scenarios.ts";

validateScenarioInventory();
console.log(
  JSON.stringify(
    {
      deterministic: scenarioFiles("deterministic"),
      development: scenarioFiles("development"),
      packaged: scenarioFiles("packaged"),
      scaleCoverage,
    },
    null,
    2,
  ),
);
