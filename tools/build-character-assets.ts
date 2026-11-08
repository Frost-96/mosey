import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { atlasSchema } from "../src/shared/assets.ts";
import { createHitRows } from "./asset-hit-rows.ts";

const frameSchema = atlasSchema.shape.frames.element
  .omit({ hitRows: true })
  .extend({
    readableRegions: z
      .array(atlasSchema.shape.frames.element.shape.region)
      .optional(),
  });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const actionConfiguration = z.strictObject({
  image: z.string().regex(/^sprites\/[a-z]+\.(png|webp)$/),
  sha256,
  loop: atlasSchema.shape.loop,
  frames: z.array(frameSchema).min(1),
});
const configuration = z.partialRecord(
  atlasSchema.shape.action,
  actionConfiguration,
);
const extensions = z.strictObject({
  version: z.literal(1),
  // Provenance of the adopted description, not mutable candidate build inputs.
  sources: z.array(
    z.strictObject({
      file: z.string().regex(/^extensions\/(?:[a-z0-9-]+\/)+[a-z-]+\.json$/),
      sha256,
      actions: z.array(atlasSchema.shape.action).min(1),
    }),
  ),
  actions: z.partialRecord(
    atlasSchema.shape.action,
    actionConfiguration.extend({
      image: z
        .string()
        .regex(/^extensions\/(?:[a-z0-9-]+\/)+[a-z0-9-]+\.(png|webp)$/),
    }),
  ),
});

export async function readCharacterAssets() {
  const characters = [];
  const inputs: string[] = [];
  for (const character of ["claude", "gemini", "gpt", "whale"]) {
    const directory = `src/assets/characters/${character}`;
    const processing = `${directory}/processing.json`;
    const actions = configuration.parse(
      JSON.parse(await readFile(processing, "utf8")),
    );
    inputs.push(processing);
    const description = `${directory}/extensions.json`;
    const bytes = await readFile(description, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (bytes !== undefined) {
      const adopted = extensions.parse(JSON.parse(bytes));
      inputs.push(description);
      for (const [action, config] of Object.entries(adopted.actions)) {
        if (Object.hasOwn(actions, action))
          throw new Error(`Duplicate adopted action: ${character}/${action}`);
        Object.assign(actions, { [action]: config });
      }
    }
    inputs.push(
      ...Object.values(actions).map((config) => `${directory}/${config.image}`),
    );
    characters.push({ character, directory, actions });
  }
  return { characters, inputs };
}

// These inputs are the adopted preview pixels, not regenerated approximations.
export async function buildCharacterAssets({
  characters,
}: Awaited<ReturnType<typeof readCharacterAssets>>) {
  for (const { character, directory, actions } of characters) {
    const output = `src/assets/generated/${character}`;
    await mkdir(output, { recursive: true });
    const written = new Set<string>();
    for (const [action, config] of Object.entries(actions)) {
      const bytes = await readFile(`${directory}/${config.image}`);
      if (createHash("sha256").update(bytes).digest("hex") !== config.sha256)
        throw new Error(`Adopted pixels changed: ${character}/${action}`);
      const image = `${action === "resting" ? "idle" : action}-atlas.png`;
      const { data, info } = await sharp(bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const frames = [];
      const readable = Buffer.from(data);
      const hasLettering = config.frames.some(
        (frame) => frame.readableRegions?.length,
      );
      for (const [index, frame] of config.frames.entries()) {
        const r = frame.region;
        if (r.width !== 480 || r.height !== 480)
          throw new Error(
            `Invalid frame size: ${character}/${action} frame ${index}`,
          );
        const pixels = await sharp(data, { raw: info })
          .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
          .raw()
          .toBuffer();
        const hitRows = createHitRows(pixels, r.width, r.height);
        if (!hitRows.some((row) => row.length))
          throw new Error(`Empty ${character}/${action} frame ${index}`);
        if (hitRows.slice(frame.foot.y).some((row) => row.length))
          throw new Error(
            `Pixels below support: ${character}/${action} frame ${index}`,
          );
        const { readableRegions, ...geometry } = frame;
        for (const area of readableRegions ?? []) {
          if (area.x + area.width > r.width || area.y + area.height > r.height)
            throw new Error(
              `Lettering outside ${character}/${action} frame ${index}`,
            );
          // Keep ZZZ readable when facing left. Only RGB inside the selected
          // letters changes; alpha remains the exact mirrored hit-test mask.
          for (let y = area.y; y < area.y + area.height; y++)
            for (let x = 0; x < area.width; x++) {
              const to = ((r.y + y) * info.width + r.x + area.x + x) * 4;
              const from =
                ((r.y + y) * info.width + r.x + area.x + area.width - 1 - x) *
                4;
              if (data[to + 3]! >= 128 && data[from + 3]! >= 128)
                data.copy(readable, to, from, from + 3);
            }
        }
        frames.push({ ...geometry, hitRows });
      }
      const leftImage = hasLettering
        ? image.replace(".png", "-left.png")
        : undefined;
      if (leftImage) {
        const mirrored = Buffer.from(data);
        for (const { region: r } of config.frames)
          for (let y = 0; y < r.height; y++)
            for (let x = 0; x < r.width; x++) {
              const from = ((r.y + y) * info.width + r.x + x) * 4;
              const to = ((r.y + y) * info.width + r.x + r.width - 1 - x) * 4;
              readable.copy(mirrored, to, from, from + 4);
            }
        await sharp(mirrored, { raw: info })
          .png()
          .toFile(`${output}/${leftImage}`);
        written.add(leftImage);
      }
      const atlas = atlasSchema.parse({
        version: 1,
        action,
        image,
        ...(leftImage ? { leftImage } : {}),
        width: info.width,
        height: info.height,
        pixelRatio: 2,
        hitAlphaThreshold: 128,
        loop: config.loop,
        frames,
      });
      await sharp(data, { raw: info }).png().toFile(`${output}/${image}`);
      const metadata = image.replace(".png", ".json");
      await writeFile(`${output}/${metadata}`, JSON.stringify(atlas) + "\n");
      written.add(image);
      written.add(metadata);
    }
    // Retire obsolete generated images, including the previous whale sleep maps.
    for (const file of await readdir(output))
      if (
        /^[a-z]+-atlas(?:-left)?\.(png|json)$/.test(file) &&
        !written.has(file)
      )
        await rm(`${output}/${file}`);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await buildCharacterAssets(await readCharacterAssets());
