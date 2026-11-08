import { PNG } from "pngjs";

const decode = (value: string) =>
  PNG.sync.read(Buffer.from(value.split(",")[1]!, "base64"));

// Canvas readback and a rebuilt context can round scaled atlas pixels
// differently. Compare painted RGBA, not PNG encoding. Bound EACH channel of
// EACH pixel, including alpha, as well as the total error. The ordinary 240 DIP
// fixture differs by <=2 levels. Fractional preview sampling measured peaks of
// 15 at 1x and 17 at 2x; its local cap of 24 leaves rasterization margin. Both
// retain a stricter mean limit (0.5) than the previous preview check (1).
export function matchPaintedFrames(
  values: Iterable<string>,
  { maxChannelDifference = 2 } = {},
) {
  const encoded = new Set(values);
  const references = [...encoded].map(decode);
  return (value: string) => {
    if (encoded.has(value)) return true;
    const actual = decode(value);
    return references.some((reference) => {
      if (
        actual.width !== reference.width ||
        actual.height !== reference.height
      )
        return false;
      let error = 0;
      for (let i = 0; i < actual.data.length; i += 4) {
        const alpha = actual.data[i + 3]!;
        const expectedAlpha = reference.data[i + 3]!;
        const alphaDifference = Math.abs(alpha - expectedAlpha);
        if (alphaDifference > maxChannelDifference) return false;
        error += alphaDifference;
        for (let channel = 0; channel < 3; channel++) {
          const difference = Math.abs(
            (actual.data[i + channel]! * alpha) / 255 -
              (reference.data[i + channel]! * expectedAlpha) / 255,
          );
          if (difference > maxChannelDifference) return false;
          error += difference;
        }
      }
      return error / actual.data.length <= 0.5;
    });
  };
}

// Select the deepest painted interior so a target survives ordinary frame
// changes between Canvas readback and pointer delivery. Run in the renderer.
export function paintedBodyPoint(minAlpha: number) {
  const canvas = document.querySelector("canvas")!;
  const { data, width, height } = canvas
    .getContext("2d")!
    .getImageData(0, 0, canvas.width, canvas.height);
  // The median opaque pixel can be on an outline edge that disappears on the
  // next frame. Choose the deepest visible interior, not an arbitrary
  // pixel in scan order, so a moving-body click survives ordinary latency.
  const distance = new Uint16Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (data[index * 4 + 3]! > minAlpha)
        distance[index] =
          1 +
          Math.min(
            x ? distance[index - 1]! : 0,
            y ? distance[index - width]! : 0,
          );
    }
  let deepest = 0;
  let point: { x: number; y: number } | undefined;
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const index = y * width + x;
      if (distance[index])
        distance[index] = Math.min(
          distance[index]!,
          1 +
            Math.min(
              x < width - 1 ? distance[index + 1]! : 0,
              y < height - 1 ? distance[index + width]! : 0,
            ),
        );
      if (distance[index]! > deepest) {
        deepest = distance[index]!;
        point = { x, y };
      }
    }
  if (!point) throw new Error("No visible body for secondary click");
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((point.x + 0.5) * rect.width) / width,
    y: ((point.y + 0.5) * rect.height) / height,
  };
}
