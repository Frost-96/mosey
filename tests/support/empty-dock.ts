import { chmod, readFile, writeFile } from "node:fs/promises";

// Ground-based scenarios require no temporary Dock support. Substitute only
// the OS capture producer, using the same wire boundary as dock.test.ts;
// native permissions and the user's live Dock must not choose these tests' floor.
export async function emptyDockCapture(helper: string) {
  const original = await readFile(helper);
  await writeFile(
    helper,
    `#!${process.execPath}
const start = performance.now(); let sequence = 0;
console.log(JSON.stringify({type: 'environment', protocol: 1, processID: process.pid, parentPID: process.ppid}));
setInterval(() => console.log(JSON.stringify({type: 'observation', elapsed: (performance.now() - start) / 1000, sequence: ++sequence, sourceAgeSeconds: 0, callbackAgeSeconds: 0, idle: false, reason: 'alpha_empty', observation: null})), 100);
`,
  );
  await chmod(helper, 0o755);
  return () => writeFile(helper, original);
}
