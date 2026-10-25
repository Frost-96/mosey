import { z } from "zod";
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
  version: z.literal(1),
  visibility: z.enum(["visible", "hidden"]),
  size: z.enum(["small", "medium", "large"]).default("medium"),
});
type Preferences = z.infer<typeof schema>;

// Only preferences are durable. Actions, motion, screen coordinates and login
// settings never enter this document. Rename is the commit point of a write.
export class PreferencesStore {
  private readonly file: string;
  private value: Preferences;
  constructor(private readonly directory: string) {
    this.file = path.join(directory, "preferences.json");
    this.value = this.read(this.file) ??
      this.read(`${this.file}.bak`) ?? {
        version: 1,
        visibility: "visible",
        size: "medium",
      };
  }
  get visibility() {
    return this.value.visibility;
  }
  private read(file: string): Preferences | undefined {
    try {
      return schema.parse(JSON.parse(readFileSync(file, "utf8")));
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
    const next = schema.parse({ ...this.value, visibility });
    try {
      mkdirSync(this.directory, { recursive: true });
      // Never replace the known-good backup with a damaged primary. The
      // previous validated value is also available when startup used defaults.
      this.replace(`${this.file}.bak`, this.value);
      this.replace(this.file, next);
    } catch (error) {
      log.error(
        "Unable to save pet visibility; keeping current choice",
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
