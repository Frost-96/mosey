import { PNG } from "pngjs";

const decode = (value: string) =>
  PNG.sync.read(Buffer.from(value.split(",")[1]!, "base64"));

// Compare one real canvas capture with independent, whole-cell PNG fixtures.
// Keep atlas decoding and the pixel loop in the runner: sending both strips
// through the inspector and reading every frame back stalls the renderer.
export function compareAuthoredAtlas(
  value: string,
  authoredBytes: Buffer,
  oppositeBytes: Buffer,
) {
  const actual = decode(value);
  const authored = PNG.sync.read(authoredBytes);
  const opposite = PNG.sync.read(oppositeBytes);
  const size = actual.width;
  if (
    actual.height !== size ||
    authored.height !== size ||
    authored.width % size !== 0 ||
    opposite.width !== authored.width ||
    opposite.height !== size
  )
    throw new Error("Expected square canvas cells in matching atlas strips");
  let best = { authored: Infinity, mirrored: Infinity, alpha: Infinity };
  for (let frame = 0; frame < authored.width / size; frame++) {
    const differences = { authored: 0, mirrored: 0, alpha: 0 };
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const left = (y * authored.width + frame * size + x) * 4;
        const right = (y * opposite.width + frame * size + size - 1 - x) * 4;
        const alpha = actual.data[i + 3]!;
        const authoredAlpha = authored.data[left + 3]!;
        const mirroredAlpha = opposite.data[right + 3]!;
        if (alpha !== mirroredAlpha) differences.alpha++;
        for (let channel = 0; channel < 4; channel++) {
          // Canvas quantizes premultiplied color. Compare those painted
          // values, ignoring invisible RGB while bounding every channel.
          const painted =
            actual.data[i + channel]! * (channel === 3 ? 1 : alpha / 255);
          if (
            Math.abs(
              painted -
                authored.data[left + channel]! *
                  (channel === 3 ? 1 : authoredAlpha / 255),
            ) > 2
          )
            differences.authored++;
          if (
            Math.abs(
              painted -
                opposite.data[right + channel]! *
                  (channel === 3 ? 1 : mirroredAlpha / 255),
            ) > 2
          )
            differences.mirrored++;
        }
      }
    if (differences.authored < best.authored) best = differences;
    if (best.authored === 0) break;
  }
  return best;
}

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
