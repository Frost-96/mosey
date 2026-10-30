import { execFileSync } from "node:child_process";
import { rename } from "node:fs/promises";
import path from "node:path";

// Only scenario-owned fault copies use this. A caller signs the completed copy;
// ordinary applications and original-bundle observation never change identity.
export async function isolateFaultExecutable(bundle: string, name: string) {
  const info = path.join(bundle, "Contents/Info.plist");
  const previous = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleExecutable", info],
    { encoding: "utf8", timeout: 5000 },
  ).trim();
  const executable = path.join(bundle, "Contents/MacOS", name);
  await rename(path.join(bundle, "Contents/MacOS", previous), executable);
  execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Set :CFBundleExecutable ${name}`, info],
    { timeout: 5000 },
  );
  return executable;
}
