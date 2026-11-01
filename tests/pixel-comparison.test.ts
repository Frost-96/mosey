import { test, expect } from "vitest";
import { PNG } from "pngjs";
import { compareAuthoredAtlas, matchPaintedFrames } from "./support/pixels";

function fixture() {
  const image = new PNG({ width: 16, height: 16 });
  for (let y = 4; y < 14; y++)
    for (let x = 3; x < 12; x++) {
      const i = (y * image.width + x) * 4;
      image.data.set([200, 120, 40, x === 3 ? 128 : 255], i);
    }
  return image;
}

const encode = (image: PNG, deflateLevel = 9) =>
  `data:image/png;base64,${PNG.sync.write(image, { deflateLevel }).toString("base64")}`;

test("paint comparison accepts PNG encoding and bounded raster rounding differences", () => {
  const reference = fixture();
  const matches = matchPaintedFrames([encode(reference)]);
  expect(matches(encode(reference, 0))).toBe(true);
  const rounded = fixture();
  for (let i = 0; i < rounded.data.length; i += 4)
    if (rounded.data[i + 3]) rounded.data[i] += 2;
  expect(matches(encode(rounded))).toBe(true);
});

test("paint comparison bounds every pixel instead of averaging away a local error", () => {
  const matches = matchPaintedFrames([encode(fixture())]);
  for (const channel of [0, 3]) {
    const damaged = fixture();
    damaged.data[(5 * damaged.width + 5) * 4 + channel] -= 3;
    expect(matches(encode(damaged))).toBe(false);
  }
});

test("paint comparison rejects blank, shifted, wrongly sized and different action frames", () => {
  const reference = fixture();
  const matches = matchPaintedFrames([encode(reference)]);
  expect(matches(encode(new PNG({ width: 16, height: 16 })))).toBe(false);
  expect(matches(encode(new PNG({ width: 32, height: 32 })))).toBe(false);
  const shifted = new PNG({ width: 16, height: 16 });
  PNG.bitblt(reference, shifted, 0, 0, 15, 16, 1, 0);
  expect(matches(encode(shifted))).toBe(false);
  const differentAction = fixture();
  differentAction.data.fill(0, (8 * 16 + 3) * 4, (9 * 16 + 12) * 4);
  expect(matches(encode(differentAction))).toBe(false);
});

test("paint comparison considers alpha and accepts any sampled animation frame", () => {
  const first = fixture();
  const second = fixture();
  second.data[(5 * 16 + 5) * 4] = 80;
  const matches = matchPaintedFrames([encode(first), encode(second)]);
  expect(matches(encode(first))).toBe(true);
  expect(matches(encode(second))).toBe(true);
  const transparentColor = fixture();
  transparentColor.data.set([255, 255, 255, 0], 0);
  expect(matches(encode(transparentColor))).toBe(true);
});

test("fractional scaling still rejects local damage and excessive overall error", () => {
  const reference = fixture();
  const matches = matchPaintedFrames([encode(reference)], {
    maxChannelDifference: 24,
  });
  const roundedEdge = fixture();
  roundedEdge.data[(5 * 16 + 3) * 4 + 3] += 23;
  expect(matches(encode(roundedEdge))).toBe(true);
  roundedEdge.data[(5 * 16 + 3) * 4 + 3] += 2;
  expect(matches(encode(roundedEdge))).toBe(false);
  const tinted = fixture();
  for (let i = 0; i < tinted.data.length; i += 4)
    if (tinted.data[i + 3]) tinted.data[i] += 16;
  expect(matches(encode(tinted))).toBe(false);
  const shifted = new PNG({ width: 16, height: 16 });
  PNG.bitblt(reference, shifted, 0, 0, 15, 16, 1, 0);
  expect(matches(encode(shifted))).toBe(false);
  expect(matches(encode(new PNG({ width: 16, height: 16 })))).toBe(false);
});

test("authored atlas comparison retains lettering and exact mirrored alpha across frames", () => {
  const painted = new PNG({ width: 4, height: 4 });
  painted.data.set([200, 120, 40, 255], (1 * 4 + 0) * 4);
  painted.data.set([255, 255, 255, 255], (1 * 4 + 1) * 4);
  painted.data.set([20, 60, 200, 128], (2 * 4 + 1) * 4);
  const authored = new PNG({ width: 8, height: 4 });
  authored.data.set([80, 0, 80, 255], 2 * 4);
  PNG.bitblt(painted, authored, 0, 0, 4, 4, 4, 0);
  const opposite = new PNG({ width: 8, height: 4 });
  opposite.data.set([80, 0, 80, 255], 1 * 4);
  opposite.data.set([200, 120, 40, 255], (1 * 8 + 7) * 4);
  opposite.data.set([255, 0, 255, 255], (1 * 8 + 6) * 4);
  opposite.data.set([20, 60, 200, 128], (2 * 8 + 6) * 4);
  const compare = (image: PNG) =>
    compareAuthoredAtlas(
      encode(image),
      PNG.sync.write(authored),
      PNG.sync.write(opposite),
    );
  expect(compare(painted)).toEqual({ authored: 0, mirrored: 1, alpha: 0 });
  // A different lettering pixel must fail even with the same silhouette.
  painted.data[(1 * 4 + 1) * 4 + 1] = 0;
  expect(compare(painted)).toEqual({ authored: 1, mirrored: 0, alpha: 0 });
  painted.data[(2 * 4 + 1) * 4 + 3] = 0;
  expect(compare(painted).alpha).toBe(1);
  expect(compare(new PNG({ width: 4, height: 4 })).authored).toBeGreaterThan(0);
});
