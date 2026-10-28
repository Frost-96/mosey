import { PNG } from "pngjs";

const decode = (value: string) =>
  PNG.sync.read(Buffer.from(value.split(",")[1]!, "base64"));

// Canvas readback and a rebuilt context can round scaled atlas pixels
// differently. Compare painted RGBA, not PNG encoding. Bound EACH channel of
// EACH pixel, including alpha, as well as the total error. The ordinary 240 DIP
// fixture differs by <=2 levels; the 200 DIP preview at 2x has an observed
// alpha difference of 17 at one edge pixel after renderer recovery. Both
// retain a stricter mean limit (0.5) than the previous preview check (1).
export function matchPaintedFrames(
  values: Iterable<string>,
  { resized = false } = {},
) {
  const maxChannelDifference = resized ? 17 : 2;
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
