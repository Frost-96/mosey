export type HeldPointerEvent = {
  type: string;
  buttons: number;
  screenX: number;
  screenY: number;
};

// CDP input does not move the physical cursor or own the OS button state.
// While a directed drag holds the button, every event it produces reports that
// button; an unpressed event can only come from the OS, which ends the drag.
export function describeSyntheticDragInterference(
  events: readonly HeldPointerEvent[],
) {
  const native = events.filter((event) => event.buttons === 0);
  const first = native[0];
  if (!first) return undefined;
  return (
    "Physical pointer movement reached the settings window during a synthetic drag " +
    `(${native.length} unpressed events, first at screen ` +
    `${Math.round(first.screenX)},${Math.round(first.screenY)}); the OS released ` +
    "the held button, so this run cannot validate slider behavior. Keep the " +
    "mouse still during desktop acceptance."
  );
}
