import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSyntheticDragInterference } from "../tests/support/synthetic-drag-interference.ts";

// Pointer events the settings renderer observed while a CDP drag held the
// button. Directed input always reports the held button.
const held = (x: number) => ({
  type: "pointermove",
  buttons: 1,
  screenX: x,
  screenY: 533,
});

test("a drag that only received its own held input is not interfered with", () => {
  assert.equal(
    describeSyntheticDragInterference([
      { ...held(746), type: "pointerdown" },
      held(696),
      held(645),
      held(545),
    ]),
    undefined,
  );
});

test("an unpressed native move during the hold explains the ended drag", () => {
  const description = describeSyntheticDragInterference([
    { ...held(746), type: "pointerdown" },
    held(696),
    { type: "pointermove", buttons: 0, screenX: 742.2, screenY: 300.4 },
    held(645),
    { type: "pointermove", buttons: 0, screenX: 757.2, screenY: 300.1 },
  ]);
  assert.equal(
    description,
    "Physical pointer movement reached the settings window during a synthetic drag " +
      "(2 unpressed events, first at screen 742,300); the OS released the held " +
      "button, so this run cannot validate slider behavior. Keep the mouse still " +
      "during desktop acceptance.",
  );
});
