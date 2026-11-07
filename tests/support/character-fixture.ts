import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

// Prepared resources at the installed-character filesystem boundary. ZIP input
// and source-image processing belong to the subsequent import work item.
export async function writeCharacterFixture(
  profile: string,
  {
    id = "minimal",
    name = "五动作角色",
    extra = [] as string[],
    color = [220, 30, 210],
    left = 140,
  } = {},
) {
  const directory = path.join(profile, "characters", id);
  await mkdir(directory, { recursive: true });
  const atlases = [];
  for (const action of [
    "resting",
    "walking",
    "dragging",
    "falling",
    "landing",
    ...extra,
  ]) {
    const image = `${action === "resting" ? "idle" : action}-atlas.png`;
    const png = new PNG({ width: 960, height: 480 });
    const frames = [];
    for (let frame = 0; frame < 2; frame++) {
      const top =
        (["sleeping", "ear"].includes(action) ? 400 : 240) - frame * 20;
      const right = left + 140 + frame * 10;
      for (let y = top; y < 480; y++)
        for (let x = left; x < right; x++) {
          const offset = (y * png.width + frame * 480 + x) * 4;
          png.data.set([...color, 255], offset);
        }
      frames.push({
        region: { x: frame * 480, y: 0, width: 480, height: 480 },
        durationMs: 250,
        foot: { x: 240, y: 480 },
        hitRows: Array.from({ length: 480 }, (_, y) =>
          y < top ? [] : [[left, right]],
        ),
      });
    }
    await writeFile(path.join(directory, image), PNG.sync.write(png));
    atlases.push({
      version: 1,
      action,
      image,
      width: 960,
      height: 480,
      pixelRatio: 2,
      loop: ["resting", "walking", "dragging", "falling", "sleeping"].includes(
        action,
      )
        ? "repeat"
        : "once",
      hitAlphaThreshold: 128,
      frames,
    });
  }
  await writeFile(
    path.join(directory, "character.json"),
    JSON.stringify({ version: 1, id, name, atlases }),
  );
  return directory;
}
