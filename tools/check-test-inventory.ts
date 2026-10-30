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
      preparation: scenarioFiles("preparation"),
      "preparation-packaged": scenarioFiles("preparation-packaged"),
      "lifecycle-development": scenarioFiles("lifecycle-development"),
      "lifecycle-packaged": scenarioFiles("lifecycle-packaged"),
      scaleCoverage,
    },
    null,
    2,
  ),
);
