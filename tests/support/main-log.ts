import { readFile } from "node:fs/promises";
import type { ElectronApplication } from "playwright";

// The main process log keeps technical failure details that the interface
// states in its own words. The log file outlives a launch, so a reader sees
// only what was written after it was opened.
export async function readMainLogFromNow(
  app: Pick<ElectronApplication, "evaluate">,
) {
  const file = await app.evaluate(({ app }) =>
    process.getBuiltinModule("node:path").join(app.getPath("logs"), "main.log"),
  );
  const contents = () => readFile(file).catch(() => Buffer.alloc(0));
  const start = (await contents()).length;
  return async () => {
    const all = await contents();
    // A rotated log starts over.
    return (all.length >= start ? all.subarray(start) : all).toString("utf8");
  };
}
