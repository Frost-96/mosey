import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function fingerprint(paths: string[]): Promise<string> {
  const hash = createHash("sha256");
  async function visit(file: string) {
    const metadata = await stat(file);
    hash.update(JSON.stringify([file, metadata.mode & 0o777]));
    if (metadata.isDirectory()) {
      for (const name of (await readdir(file)).sort())
        await visit(path.join(file, name));
    } else {
      hash.update(await readFile(file));
    }
  }
  for (const file of [...paths].sort()) await visit(file);
  return hash.digest("hex");
}

// Receipts live only in the local ignored build directory. Validate outputs as
// well as inputs: application tests temporarily replace native executables.
export async function prepareBuild({
  name,
  inputs,
  outputs,
  identity,
  directory = "build",
}: {
  name: string;
  inputs: string[];
  outputs: string[];
  identity: unknown;
  directory?: string;
}) {
  const started = performance.now();
  const receipt = path.join(directory, "incremental", `${name}.json`);
  const source = () => fingerprint([...inputs, fileURLToPath(import.meta.url)]);
  const input = await source();
  const key = JSON.stringify({ input, identity });
  let previous: { key?: string; output?: string } | undefined;
  let output: string | undefined;
  try {
    previous = JSON.parse(await readFile(receipt, "utf8"));
    output = await fingerprint(outputs);
  } catch (error) {
    if (
      !(error instanceof SyntaxError) &&
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    )
      throw error;
  }
  const current =
    output !== undefined && previous?.key === key && previous.output === output;
  async function record(reused: boolean) {
    await mkdir(directory, { recursive: true });
    const seconds = (performance.now() - started) / 1000;
    await appendFile(
      path.join(directory, "timings.jsonl"),
      JSON.stringify({ name, reused, seconds }) + "\n",
    );
    console.log(
      `${name}: ${reused ? "unchanged" : "built"} (${seconds.toFixed(3)}s)`,
    );
  }
  if (current) await record(true);
  return {
    current,
    async complete() {
      if ((await source()) !== input)
        throw new Error(`${name}: inputs changed during the build`);
      const output = await fingerprint(outputs);
      await mkdir(path.dirname(receipt), { recursive: true });
      const temporary = `${receipt}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ key, output }));
      await rename(temporary, receipt);
      await record(false);
    },
  };
}
