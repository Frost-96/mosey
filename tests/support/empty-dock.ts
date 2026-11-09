import { chmod, readFile, stat, writeFile } from "node:fs/promises";

// Ground-based scenarios require no temporary Dock support. Substitute only
// the OS capture producer, using the same wire boundary as dock.test.ts;
// native permissions and the user's live Dock must not choose these tests' floor.
export async function emptyDockCapture(helper: string) {
  const original = await readFile(helper);
  const mode = (await stat(helper)).mode & 0o777;
  const restore = async () => {
    await writeFile(helper, original);
    await chmod(helper, mode);
  };
  try {
    await writeFile(
      helper,
      `#!${process.execPath}
const start = performance.now(); let sequence = 0;
console.log(JSON.stringify({type: 'environment', protocol: 1, processID: process.pid, parentPID: process.ppid}));
setInterval(() => console.log(JSON.stringify({type: 'observation', elapsed: (performance.now() - start) / 1000, sequence: ++sequence, sourceAgeSeconds: 0, callbackAgeSeconds: 0, idle: false, reason: 'alpha_empty', observation: null})), 100);
`,
    );
    await chmod(helper, 0o755);
  } catch (error) {
    try {
      await restore();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Dock substitution and restoration failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
  return restore;
}
