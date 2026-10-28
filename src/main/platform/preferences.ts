import { z } from "zod";
import { characterSchema } from "../../shared/contract";
import { petSizeSchema, type PetSize } from "../../shared/size";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import log from "electron-log/main";

const schema = z.strictObject({
  version: z.literal(3),
  character: characterSchema,
  visibility: z.enum(["visible", "hidden"]),
  size: petSizeSchema.default(160),
});
type Preferences = z.infer<typeof schema>;

// Only preferences are durable. Actions, motion, screen coordinates and login
// settings never enter this document. Rename is the commit point of a write.
export class PreferencesStore {
  private readonly file: string;
  private value: Preferences;
  private migrationNeeded = false;
  constructor(private readonly directory: string) {
    this.file = path.join(directory, "preferences.json");
    this.value = this.read(this.file) ??
      this.read(`${this.file}.bak`) ?? {
        version: 3,
        character: "whale",
        visibility: "visible",
        size: 160,
      };
    if (this.migrationNeeded) this.save(this.value, "migration");
  }
  get character() {
    return this.value.character;
  }
  get visibility() {
    return this.value.visibility;
  }
  get size() {
    return this.value.size;
  }
  setCharacter(character: Preferences["character"]): boolean {
    return this.save({ ...this.value, character }, "character");
  }
  setSize(size: PetSize): boolean {
    return this.save({ ...this.value, size }, "size");
  }
  private read(file: string): Preferences | undefined {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      const legacy = z
        .strictObject({
          version: z.literal(1),
          visibility: z.enum(["visible", "hidden"]),
          size: z.enum(["small", "medium", "large"]).default("medium"),
        })
        .safeParse(raw);
      if (legacy.success) {
        this.migrationNeeded = true;
        return {
          version: 3,
          character: "whale",
          visibility: legacy.data.visibility,
          size: { small: 70, medium: 160, large: 240 }[legacy.data.size],
        };
      }
      const previous = z
        .strictObject({
          version: z.literal(2),
          visibility: z.enum(["visible", "hidden"]),
          size: petSizeSchema.default(160),
        })
        .safeParse(raw);
      if (previous.success) {
        this.migrationNeeded = true;
        return { ...previous.data, version: 3, character: "whale" };
      }
      return schema.parse(raw);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return;
      log.error(
        "Invalid pet preferences; trying recovery",
        file,
        String(error),
      );
      return;
    }
  }
  private replace(file: string, value: Preferences) {
    const temporary = `${file}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  }
  setVisibility(visibility: Preferences["visibility"]): boolean {
    return this.save({ ...this.value, visibility }, "visibility");
  }
  private save(value: Preferences, choice: string): boolean {
    const next = schema.parse(value);
    try {
      mkdirSync(this.directory, { recursive: true });
      // Never replace the known-good backup with a damaged primary. The
      // previous validated value is also available when startup used defaults.
      this.replace(`${this.file}.bak`, this.value);
      this.replace(this.file, next);
    } catch (error) {
      log.error(
        `Unable to save pet ${choice}; keeping current choice`,
        String(error),
      );
      return false;
    }
    this.value = next;
    // The committed file is authoritative even if directory sync is unavailable.
    try {
      const fd = openSync(this.directory, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      log.warn("Preferences directory sync unavailable", String(error));
    }
    return true;
  }
}
