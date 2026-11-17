import { nativeImage, type NativeImage } from "electron";

// A paw drawn in a 24-unit square: one pad and four toes.
const pad = { x: 12, y: 16, rx: 6, ry: 5 };
const toes = [
  { x: 5, y: 9 },
  { x: 9.5, y: 5 },
  { x: 14.5, y: 5 },
  { x: 19, y: 9 },
];
const toeRadius = 2.5;

const inside = (x: number, y: number) =>
  ((x - pad.x) / pad.rx) ** 2 + ((y - pad.y) / pad.ry) ** 2 <= 1 ||
  toes.some((toe) => (x - toe.x) ** 2 + (y - toe.y) ** 2 <= toeRadius ** 2);

// Rasterize with 4×4 supersampling into BGRA. Only alpha carries the shape:
// a template image is recolored by macOS for light and dark menu bars.
function paw(size: number) {
  const samples = 4;
  const buffer = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++)
          if (
            inside(
              ((px + (sx + 0.5) / samples) / size) * 24,
              ((py + (sy + 0.5) / samples) / size) * 24,
            )
          )
            covered++;
      buffer[(py * size + px) * 4 + 3] = Math.round(
        (covered / samples ** 2) * 255,
      );
    }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

export function pawTemplateImage(): NativeImage {
  const image = nativeImage.createFromBuffer(paw(16).toPNG(), {
    scaleFactor: 1,
  });
  image.addRepresentation({ scaleFactor: 2, buffer: paw(32).toPNG() });
  image.setTemplateImage(true);
  return image;
}
