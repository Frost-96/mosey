import { setup } from "xstate";
// Behavior is platform independent. System visibility is managed separately.
export const petBehavior = setup({}).createMachine({
  id: "pet",
  initial: "resting",
  states: { resting: {} },
});
