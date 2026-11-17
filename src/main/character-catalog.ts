import { characterCapabilities } from "../shared/character-capabilities";
import { app, nativeImage, protocol } from "electron";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import log from "electron-log/main";
import {
  characterIdentitySchema,
  characterResourceKey,
  type CharacterId,
} from "../shared/character-catalog";
import {
  characterPackageSchema,
  type CharacterPackage,
  characterLoopTimings,
  characterWalk,
  type PreparedCharacter,
} from "../shared/characters";
import { characterGeometry } from "../shared/character-geometry";

// Every prepared selection owns immutable metadata AND image bytes. Replacing
// files on disk cannot change a version that is being displayed or decoded.
export class CharacterCatalog {
  private readonly entries = new Map<
    CharacterId,
    { id: string; name: string; directory: string }
  >();
  private readonly resources = new Map<string, Map<string, Buffer>>();
  // Thumbnails are derived on demand and keyed like prepared resources, so an
  // updated installed package yields a new image under the same address.
  private readonly thumbnails = new Map<string, Buffer>();

  constructor() {
    this.discover(
      app.isPackaged
        ? path.join(process.resourcesPath, "characters")
        : path.join(app.getAppPath(), "build/characters"),
    );
    this.discover(path.join(app.getPath("userData"), "characters"));
    protocol.handle("mosey-asset", async (request) => {
      const url = new URL(request.url);
      const [, id, version, filename, ...rest] = url.pathname.split("/");
      const pixels =
        request.method !== "GET"
          ? undefined
          : url.hostname === "character" && rest.length === 0
            ? this.resources.get(`${id}:${version}`)?.get(filename!)
            : url.hostname === "thumbnail" && version === undefined
              ? await this.thumbnail(id!)
              : undefined;
      return new Response(pixels ? new Uint8Array(pixels) : null, {
        status: pixels ? 200 : 404,
        headers: {
          "Content-Type": "image/png",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    });
    app.once("will-quit", () => protocol.unhandle("mosey-asset"));
  }

  get list() {
    return [...this.entries.values()]
      .map(({ id, name }) => ({ id, name }))
      .sort(
        (a, b) =>
          Number(b.id === "whale") - Number(a.id === "whale") ||
          a.name.localeCompare(b.name, "en"),
      );
  }

  commit(character: PreparedCharacter) {
    const entry = this.entries.get(character.id);
    if (entry)
      this.entries.set(character.id, { ...entry, name: character.name });
  }

  private discover(root: string) {
    let directories;
    try {
      directories = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      try {
        const location = path.join(root, directory.name);
        const raw = JSON.parse(
          readFileSync(path.join(location, "character.json"), "utf8"),
        );
        const identity = characterIdentitySchema.parse({
          id: raw.id,
          name: raw.name,
        });
        if (this.entries.has(identity.id))
          throw new Error(`Duplicate character: ${identity.id}`);
        this.entries.set(identity.id, { ...identity, directory: location });
      } catch (error) {
        log.error("Invalid installed character", directory.name, String(error));
      }
    }
  }

  load(id: CharacterId) {
    const { directory, character } = this.read(id);
    const files = new Map<string, Buffer>();
    for (const filename of atlasFiles(character))
      files.set(filename, readFileSync(confined(directory, filename)));
    const resourceVersion = versionOf(character, files);
    const key = characterResourceKey({ character: id, resourceVersion });
    this.resources.set(key, files);
    const prepared: PreparedCharacter = {
      id,
      name: character.name,
      resourceVersion,
      atlases: character.atlases,
      images: Object.fromEntries(
        [...files.keys()].map((filename) => [
          filename,
          `mosey-asset://character/${id}/${resourceVersion}/${filename}`,
        ]),
      ),
    };
    return {
      ...prepared,
      prepared,
      capabilities: characterCapabilities(
        character.atlases.map((atlas) => atlas.action),
      ),
      walk: characterWalk(character),
      loopTimings: characterLoopTimings(character),
      geometry: characterGeometry(character.atlases),
    };
  }

  private read(id: CharacterId) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown character: ${id}`);
    const directory = realpathSync(entry.directory);
    const character = characterPackageSchema.parse(
      JSON.parse(readFileSync(path.join(directory, "character.json"), "utf8")),
    );
    if (character.id !== id) throw new Error("Character identity changed");
    return { directory, character };
  }

  // The first resting frame, trimmed to its opaque rows. Files are read
  // asynchronously: settings may request every character while the pet moves.
  private async thumbnail(id: string) {
    try {
      const { directory, character } = this.read(id);
      const files = new Map<string, Buffer>();
      for (const filename of atlasFiles(character)) {
        const file = await realpath(path.join(directory, filename));
        if (path.dirname(file) !== directory)
          throw new Error("Image escapes character directory");
        files.set(filename, await readFile(file));
      }
      const key = characterResourceKey({
        character: id,
        resourceVersion: versionOf(character, files),
      });
      const cached = this.thumbnails.get(key);
      if (cached) return cached;
      const atlas = character.atlases.find(
        (atlas) => atlas.action === "resting",
      )!;
      const { region, hitRows } = atlas.frames[0]!;
      const runs = hitRows.flat();
      const rows = hitRows.flatMap((row, y) => (row.length ? [y] : []));
      if (!runs.length) throw new Error("Empty resting frame");
      const left = Math.min(...runs.map(([start]) => start));
      const top = rows[0]!;
      const width = Math.max(...runs.map(([, end]) => end)) - left;
      const height = rows.at(-1)! + 1 - top;
      const image = nativeImage.createFromBuffer(files.get(atlas.image)!);
      const decoded = image.getSize();
      if (decoded.width !== atlas.width || decoded.height !== atlas.height)
        throw new Error("Resting atlas does not match its description");
      const scale = Math.min(1, 192 / Math.max(width, height));
      const pixels = image
        .crop({ x: region.x + left, y: region.y + top, width, height })
        .resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: "best",
        })
        .toPNG();
      for (const old of this.thumbnails.keys())
        if (old.startsWith(`${id}:`)) this.thumbnails.delete(old);
      this.thumbnails.set(key, pixels);
      return pixels;
    } catch (error) {
      log.warn("Character thumbnail unavailable", id, String(error));
      return undefined;
    }
  }

  retain(...characters: PreparedCharacter[]) {
    const live = new Set(
      characters.map((character) =>
        characterResourceKey({
          character: character.id,
          resourceVersion: character.resourceVersion,
        }),
      ),
    );
    for (const key of this.resources.keys())
      if (!live.has(key)) this.resources.delete(key);
  }
}

function atlasFiles(character: CharacterPackage) {
  return [
    ...new Set(
      character.atlases.flatMap((atlas) =>
        atlas.leftImage ? [atlas.image, atlas.leftImage] : [atlas.image],
      ),
    ),
  ];
}

function confined(directory: string, filename: string) {
  const file = realpathSync(path.join(directory, filename));
  if (path.dirname(file) !== directory)
    throw new Error("Image escapes character directory");
  return file;
}

// The resource version covers the prepared description and every image byte.
function versionOf(character: CharacterPackage, files: Map<string, Buffer>) {
  const hash = createHash("sha256").update(JSON.stringify(character));
  for (const [filename, pixels] of files) hash.update(filename).update(pixels);
  return hash.digest("hex");
}
