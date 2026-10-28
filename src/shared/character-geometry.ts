import type { Atlas } from "./assets";
import type { PetSize } from "./size";

type Point = { x: number; y: number };
type Extent = { left: number; right: number; top: number };
type Pose = {
  posture: Atlas["action"];
  frame: number;
  direction: "left" | "right";
  size: PetSize;
};

// All projections are window-local DIP. Display DPR belongs only to the
// renderer's backing store; it never changes alpha coordinates or contact.
const referenceSize = 240;
function transform(
  atlas: Atlas,
  frame: Atlas["frames"][number],
  pose: Pick<Pose, "size" | "direction">,
) {
  const scale = pose.size / referenceSize / atlas.pixelRatio;
  const left = pose.direction === "left";
  const x = pose.size / 2 - frame.foot.x * scale;
  return {
    x: left ? pose.size - x : x,
    y: pose.size - frame.foot.y * scale,
    sx: left ? -scale : scale,
    sy: scale,
  };
}

function project(extent: Extent, placement: ReturnType<typeof transform>) {
  const first = placement.x + extent.left * placement.sx;
  const last = placement.x + extent.right * placement.sx;
  return {
    left: Math.min(first, last),
    right: Math.max(first, last),
    top: placement.y + extent.top * placement.sy,
  };
}

// One prepared character owns frame lookup, forward/inverse projection and
// the common contact across every action and facing. Callers choose the pose
// (in particular, the last painted pose for input), never assemble transforms.
export function characterGeometry(atlases: readonly Atlas[]) {
  const actions = new Map(
    atlases.map((atlas) => [
      atlas.action,
      {
        atlas,
        frames: atlas.frames.map((frame) => {
          const runs = frame.hitRows.flat();
          const extent = runs.length
            ? {
                left: Math.min(...runs.map(([start]) => start)),
                right: Math.max(...runs.map(([, end]) => end)),
                top: frame.hitRows.findIndex((row) => row.length > 0),
              }
            : undefined;
          return { frame, extent };
        }),
      },
    ]),
  );
  let contactLeft = -Infinity;
  let contactRight = Infinity;
  for (const { atlas, frames } of actions.values()) {
    for (const { frame, extent } of frames) {
      if (!extent) {
        contactLeft = Infinity;
        contactRight = -Infinity;
        continue;
      }
      for (const direction of ["left", "right"] as const) {
        const projected = project(
          extent,
          transform(atlas, frame, {
            direction,
            size: referenceSize,
          }),
        );
        contactLeft = Math.max(contactLeft, projected.left);
        contactRight = Math.min(contactRight, projected.right);
      }
    }
  }

  return {
    frame(pose: Pose) {
      const action = actions.get(pose.posture);
      const entry = action?.frames[pose.frame];
      if (!action || !entry) return undefined;
      const { atlas } = action;
      const { frame, extent } = entry;
      const placement = transform(atlas, frame, pose);
      const authoredLeft = pose.direction === "left" && atlas.leftImage;
      // Authored left pixels already mirror the ordinary alpha mask, while
      // preserving readable lettering. Only drawing uses this alternate map;
      // hit tests and outlines always invert/project the ordinary alpha rows.
      const drawing = {
        image: authoredLeft || atlas.image,
        source: frame.region,
        transform: [
          authoredLeft ? placement.sy : placement.sx,
          0,
          0,
          placement.sy,
          authoredLeft
            ? placement.x - frame.region.width * placement.sy
            : placement.x,
          placement.y,
        ] as [number, number, number, number, number, number],
      };
      return {
        drawing,
        contains(point: Point) {
          const x = Math.floor((point.x - placement.x) / placement.sx);
          const y = Math.floor((point.y - placement.y) / placement.sy);
          return (
            frame.hitRows[y]?.some(([start, end]) => x >= start && x < end) ??
            false
          );
        },
        boundsAt(origin: Point) {
          if (!extent) return undefined;
          const bounds = project(extent, placement);
          return {
            left: origin.x + bounds.left,
            right: origin.x + bounds.right,
            top: origin.y + bounds.top,
            // Side avoidance spans the painted top down to the aligned foot.
            bottom: origin.y + pose.size,
          };
        },
      };
    },
    contactAt(size: PetSize, x: number) {
      if (
        !Number.isFinite(contactLeft) ||
        !Number.isFinite(contactRight) ||
        contactLeft >= contactRight
      )
        return undefined;
      const scale = size / referenceSize;
      return { left: x + contactLeft * scale, right: x + contactRight * scale };
    },
  };
}
