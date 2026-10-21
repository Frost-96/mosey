// Absolute desktop DIP only. A contour is an observed alpha edge, never a
// window rectangle, Dock preference or workArea approximation.
export interface DockSurface {
  orientation: "bottom" | "left" | "right";
  contour: { axis: number; inward: number }[];
}
export function dockSupport(
  surface: DockSurface | null,
  body: { left: number; right: number; top: number; bottom: number },
  floor: number,
) {
  if (!surface) return { footY: floor, shiftX: 0 };
  const horizontal = surface.orientation === "bottom";
  const points = surface.contour.filter(({ axis }) =>
    horizontal
      ? axis >= body.left && axis <= body.right
      : axis >= body.top && axis <= body.bottom,
  );
  if (!points.length) return { footY: floor, shiftX: 0 };
  if (horizontal)
    return {
      footY: Math.min(floor, ...points.map(({ inward }) => inward)),
      shiftX: 0,
    };
  const boundary =
    surface.orientation === "left"
      ? Math.max(...points.map(({ inward }) => inward))
      : Math.min(...points.map(({ inward }) => inward));
  return {
    footY: floor,
    shiftX:
      surface.orientation === "left"
        ? Math.max(0, boundary + 2 - body.left)
        : Math.min(0, boundary - 2 - body.right),
  };
}
