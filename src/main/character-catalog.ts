import { characterCapabilities } from "../shared/character-capabilities";
import { app, protocol } from "electron";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
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
import { atlasSchema } from "../shared/assets";
import { characterGeometry } from "../shared/character-geometry";
import { restingThumbnail } from "./character-thumbnail";

// Every prepared selection owns immutable metadata AND image bytes. Replacing
// files on disk cannot change a version that is being displayed or decoded.
export class CharacterCatalog {
  private readonly entries = new Map<
    CharacterId,
    { id: string; name: string; directory: string }
  >();
  private readonly resources = new Map<string, Map<string, Buffer>>();
  // Thumbnails are derived on demand, one per character, from the first frame
  // of the resting atlas alone. Settings requests every card as it opens, on
  // the main thread that also serves both windows and their inspector. Parsing
  // and validating each whole description there (about a megabyte of hit rows
  // per built-in character) held that thread for every open. Discovery already
  // parses each description once, so it keeps the resting atlas; a request
  // reads only file metadata and the resting image. Each entry remembers the
  // size and modification time of the description it came from, and each
  // thumbnail those of the description and image, so an updated installed
  // package yields a new image under the same address.
  private readonly restingAtlases = new Map<
    string,
    { stamp: string; atlas: unknown }
  >();
  private readonly thumbnails = new Map<
    string,
    { stamp: string; pixels: Buffer }
  >();

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
        const manifest = path.join(location, "character.json");
        // Stamped before reading: a later change only causes a fresh read.
        const stamp = fileStamp(manifest, statSync(manifest));
        const raw = JSON.parse(readFileSync(manifest, "utf8"));
        const identity = characterIdentitySchema.parse({
          id: raw.id,
          name: raw.name,
        });
        if (this.entries.has(identity.id))
          throw new Error(`Duplicate character: ${identity.id}`);
        this.entries.set(identity.id, { ...identity, directory: location });
        this.restingAtlases.set(identity.id, {
          stamp,
          atlas: restingAtlasOf(raw),
        });
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

  // Files are read asynchronously: settings may request every character
  // while the pet moves.
  private async thumbnail(id: string) {
    try {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown character: ${id}`);
      const directory = await realpath(entry.directory);
      const manifest = path.join(directory, "character.json");
      const manifestStamp = fileStamp(manifest, await stat(manifest));
      let resting = this.restingAtlases.get(id);
      if (resting?.stamp !== manifestStamp) {
        const raw = JSON.parse(await readFile(manifest, "utf8"));
        if (raw?.id !== id) throw new Error("Character identity changed");
        resting = { stamp: manifestStamp, atlas: restingAtlasOf(raw) };
        this.restingAtlases.set(id, resting);
      }
      const atlas = atlasSchema.parse(resting.atlas);
      const image = confined(directory, atlas.image);
      const stamp = `${manifestStamp}\n${fileStamp(image, await stat(image))}`;
      const cached = this.thumbnails.get(id);
      if (cached?.stamp === stamp) return cached.pixels;
      const pixels = restingThumbnail(atlas, await readFile(image));
      this.thumbnails.set(id, { stamp, pixels });
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

// Unvalidated: a thumbnail validates the one atlas it draws from. Selection
// still validates the whole package before it replaces the pet.
function restingAtlasOf(raw: unknown): unknown {
  const atlases = (raw as { atlases?: unknown } | null)?.atlases;
  return Array.isArray(atlases)
    ? atlases.find((atlas) => atlas?.action === "resting")
    : undefined;
}

function fileStamp(file: string, { size, mtimeMs }: Stats) {
  return `${file}:${size}:${mtimeMs}`;
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
