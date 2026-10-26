// Called with the final RGBA pixels used to write each atlas frame.
export function createHitRows(
  pixels: Uint8Array,
  width: number,
  height: number,
) {
  const rows: [number, number][][] = [];
  for (let y = 0; y < height; y++) {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const opaque = x < width && pixels[(y * width + x) * 4 + 3]! >= 128;
      if (opaque && start < 0) start = x;
      if (!opaque && start >= 0) {
        runs.push([start, x]);
        start = -1;
      }
    }
    rows.push(runs);
  }
  return rows;
}
