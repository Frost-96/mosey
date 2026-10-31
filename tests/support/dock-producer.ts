import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

export type ProducerOperation = <T>(
  label: string,
  action: () => Promise<T>,
  options?: { timeout?: number },
) => Promise<T>;

export type DockProducer = {
  name: string;
  prepare(context: {
    root: string;
    evidence: string;
    signal: AbortSignal;
    run: ProducerOperation;
  }): Promise<string | Buffer>;
};

// Compare equivalent, already prepared inputs. Forge legitimately writes these
// before the scenario owns a copy; a producer must never write them afterwards.
export async function nativeArtifactInventory(directory: string) {
  const entries: Record<string, string> = {};
  const visit = async (relative: string) => {
    const children = await readdir(path.join(directory, relative), {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isSymbolicLink())
        entries[name] = `link:${await readlink(path.join(directory, name))}`;
      else
        entries[name] = createHash("sha256")
          .update(await readFile(path.join(directory, name)))
          .digest("hex");
    }
  };
  await visit("");
  return entries;
}
