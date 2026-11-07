import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { characterPackageSchema } from "../src/shared/characters.ts";
import catalog from "../src/assets/characters/catalog.json" with { type: "json" };
import { prepareBuild } from "./incremental-build.ts";

const build = await prepareBuild({
  name: "prepared-characters",
  inputs: [
    "tools/prepare-characters.ts",
    "src/shared/characters.ts",
    "src/shared/character-catalog.ts",
    "src/shared/character-capabilities.ts",
    "src/shared/size.ts",
    "package.json",
    "pnpm-lock.yaml",
    "src/shared/assets.ts",
    "src/assets/characters/catalog.json",
    "src/assets/generated",
    ...catalog.flatMap((entry) =>
      entry.walking ? [`src/assets/characters/${entry.walking}`] : [],
    ),
  ],
  outputs: ["build/characters"],
  identity: { node: process.version },
});
if (!build.current) {
  await rm("build/characters", { recursive: true, force: true });
  for (const entry of catalog) {
    const source = path.join("src/assets/generated", entry.assets);
    const atlases = await Promise.all(
      (await readdir(source))
        .filter((name) => name.endsWith("-atlas.json"))
        .sort()
        .map(async (name) =>
          JSON.parse(await readFile(path.join(source, name), "utf8")),
        ),
    );
    const character = characterPackageSchema.parse({
      version: 1,
      id: entry.id,
      name: entry.name,
      atlases,
      ...(entry.walking
        ? {
            walking: JSON.parse(
              await readFile(
                path.join("src/assets/characters", entry.walking),
                "utf8",
              ),
            ),
          }
        : {}),
    });
    const destination = path.join("build/characters", entry.id);
    await mkdir(destination, { recursive: true });
    for (const atlas of character.atlases)
      for (const filename of [atlas.image, atlas.leftImage].filter(
        (name) => name !== undefined,
      ))
        await cp(path.join(source, filename), path.join(destination, filename));
    await writeFile(
      path.join(destination, "character.json"),
      JSON.stringify(character) + "\n",
    );
  }
  await build.complete();
}
