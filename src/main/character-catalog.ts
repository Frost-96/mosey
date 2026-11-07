import { characterCapabilities } from "../shared/character-capabilities";
import { app, protocol } from "electron";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import log from "electron-log/main";
import {
  characterIdentitySchema,
  characterResourceKey,
  type CharacterId,
} from "../shared/character-catalog";
import {
  characterPackageSchema,
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

  constructor() {
    this.discover(
      app.isPackaged
        ? path.join(process.resourcesPath, "characters")
        : path.join(app.getAppPath(), "build/characters"),
    );
    this.discover(path.join(app.getPath("userData"), "characters"));
    protocol.handle("mosey-asset", (request) => {
      const url = new URL(request.url);
      const [, id, version, filename, ...rest] = url.pathname.split("/");
      const pixels =
        url.hostname === "character" &&
        rest.length === 0 &&
        request.method === "GET"
          ? this.resources.get(`${id}:${version}`)?.get(filename!)
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
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown character: ${id}`);
    const directory = realpathSync(entry.directory);
    const character = characterPackageSchema.parse(
      JSON.parse(readFileSync(path.join(directory, "character.json"), "utf8")),
    );
    if (character.id !== id) throw new Error("Character identity changed");
    const hash = createHash("sha256").update(JSON.stringify(character));
    const files = new Map<string, Buffer>();
    for (const atlas of character.atlases) {
      for (const filename of [atlas.image, atlas.leftImage]) {
        if (!filename || files.has(filename)) continue;
        const file = realpathSync(path.join(directory, filename));
        if (path.dirname(file) !== directory)
          throw new Error("Image escapes character directory");
        const pixels = readFileSync(file);
        hash.update(filename).update(pixels);
        files.set(filename, pixels);
      }
    }
    const resourceVersion = hash.digest("hex");
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
      geometry: characterGeometry(character.atlases),
    };
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
