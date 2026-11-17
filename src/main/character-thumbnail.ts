import { nativeImage } from "electron";
import type { Atlas } from "../shared/assets";

// The longest side of a thumbnail, in pixels. Settings shows it in a 72-point
// card image, so it stays sharp on a Retina display.
export const thumbnailMaxSide = 192;

// The first frame of the resting atlas, trimmed to its opaque area and fitted
// within thumbnailMaxSide. Returns PNG bytes.
export function restingThumbnail(atlas: Atlas, image: Buffer) {
  const { region, hitRows } = atlas.frames[0]!;
  const runs = hitRows.flat();
  const rows = hitRows.flatMap((row, y) => (row.length ? [y] : []));
  if (!runs.length) throw new Error("Empty resting frame");
  const left = Math.min(...runs.map(([start]) => start));
  const top = rows[0]!;
  const width = Math.max(...runs.map(([, end]) => end)) - left;
  const height = rows.at(-1)! + 1 - top;
  const decoded = nativeImage.createFromBuffer(image);
  const size = decoded.getSize();
  if (size.width !== atlas.width || size.height !== atlas.height)
    throw new Error("Resting atlas does not match its description");
  const scale = Math.min(1, thumbnailMaxSide / Math.max(width, height));
  return decoded
    .crop({ x: region.x + left, y: region.y + top, width, height })
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: "best",
    })
    .toPNG();
}
