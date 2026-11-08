import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import type { Atlas } from "../src/shared/assets.ts";

const revisionId = "runtime-continuity-v4";
const supported = ["whale", "claude", "gemini", "gpt"];
const requested = process.argv.slice(2);
if (requested.some((id) => !supported.includes(id)))
  throw new Error("Unknown character");
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const readJSON = async (file: string) =>
  JSON.parse(await readFile(file, "utf8"));
const save = async (file: string, value: unknown) =>
  writeFile(file, await format(JSON.stringify(value), { parser: "json" }));
type Replacement = {
  family: "runtime" | "gentle" | "expressive";
  action: Atlas["action"];
  image: string;
  sha256: string;
  loop: Atlas["loop"];
  frames: Omit<Atlas["frames"][number], "hitRows">[];
};

for (const id of requested.length ? requested : supported) {
  const root = `src/assets/characters/${id}`;
  const relative = `extensions/${revisionId}/replacements.json`;
  const directory = `${root}/extensions/${revisionId}`;
  const bytes = await readFile(`${root}/${relative}`);
  const revision = JSON.parse(bytes.toString()) as { actions: Replacement[] };
  const extension = await readJSON(`${root}/extensions.json`);
  const processing = await readJSON(`${root}/processing.json`);
  const adoption = await readJSON(`${root}/adoption.json`);
  const runtime: string[] = [],
    daily: string[] = [];
  for (const replacement of revision.actions) {
    const { action, family, image, sha256, loop } = replacement;
    if (!/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(webp|png)$/.test(image))
      throw new Error("Invalid revision path");
    const source = await readFile(`${directory}/${image}`);
    if (digest(source) !== sha256)
      throw new Error(`Revision pixels changed: ${id}/${action}`);
    const frames = replacement.frames.map(({ region, foot, durationMs }) => ({
      region,
      foot,
      durationMs,
    }));
    const config = {
      image: `extensions/${revisionId}/${image}`,
      sha256,
      loop,
      frames,
    };
    if (family === "runtime") {
      if (!processing[action])
        throw new Error(`Unknown runtime action ${action}`);
      config.image = `sprites/${action}.webp`;
      await writeFile(`${root}/${config.image}`, source);
      processing[action] = config;
      adoption.actions[action] = {
        ...adoption.actions[action],
        image: config.image,
        sha256,
        previewFrames: frames.map((frame) => ({
          ...frame,
          anchor: frame.foot,
        })),
        previewLoop: loop,
        revision: {
          id: revisionId,
          file: relative,
          sha256: digest(bytes),
          image,
        },
      };
      runtime.push(action);
    } else {
      if (!extension.actions[action])
        throw new Error(`Unknown daily action ${action}`);
      extension.actions[action] = config;
      daily.push(action);
    }
  }
  if (daily.length) {
    extension.sources = [
      ...extension.sources.filter(
        (source: { file: string }) => source.file !== relative,
      ),
      { file: relative, sha256: digest(bytes), actions: daily },
    ];
    await save(`${root}/extensions.json`, extension);
  }
  if (runtime.length) {
    adoption.revisions = [
      ...(adoption.revisions ?? []).filter(
        (revision: { id: string }) => revision.id !== revisionId,
      ),
      {
        id: revisionId,
        file: relative,
        sha256: digest(bytes),
        actions: runtime,
      },
    ];
    await save(`${root}/processing.json`, processing);
    await save(`${root}/adoption.json`, adoption);
  }
  console.log(`${id}: adopted ${revision.actions.length} continuity revisions`);
}
