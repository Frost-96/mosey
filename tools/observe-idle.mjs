import { _electron } from "playwright";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

// Observe the packaged application's visible output; no product test hooks.
// An isolated profile leaves other running Mosey probes untouched.
const executable = path.resolve(
  "out/Mosey-darwin-arm64/Mosey.app/Contents/MacOS/Mosey",
);
const output = path.resolve("test-results/issue-2-desktop");
const profile = await mkdtemp(path.join(os.tmpdir(), "mosey-issue2-profile-"));
const foreground = () => {
  const asn = execFileSync("/usr/bin/lsappinfo", ["front"], {
    encoding: "utf8",
  }).trim();
  const info = execFileSync(
    "/usr/bin/lsappinfo",
    ["info", "-only", "bundleID", asn],
    { encoding: "utf8" },
  );
  return /bundleID="([^"]+)"/.exec(info)?.[1] ?? "unavailable";
};
let app;
let child;
try {
  await mkdir(output, { recursive: true });
  const before = foreground();
  app = await _electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profile}`],
  });
  child = app.process();
  const window = await app.firstWindow();
  await window.waitForFunction(() => {
    const canvas = globalThis.document.querySelector("canvas");
    if (!canvas) return false;
    const data = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height).data;
    return data.some((value, index) => index % 4 === 3 && value >= 128);
  });
  const runtime = await app.evaluate(({ app }) => ({
    electron: globalThis.process.versions.electron,
    node: globalThis.process.versions.node,
    userData: app.getPath("userData"),
  }));
  if ((await realpath(runtime.userData)) !== (await realpath(profile)))
    throw new Error("Temporary profile isolation was not applied");
  const samples = [];
  const unique = new Map();
  const started = Date.now();
  while (Date.now() - started < 6500) {
    const bytes = await window.screenshot({ omitBackground: true });
    const png = PNG.sync.read(bytes);
    let left = png.width;
    let right = -1;
    let top = png.height;
    let bottom = -1;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        if (png.data[(y * png.width + x) * 4 + 3] >= 128) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    const digest = createHash("sha256").update(png.data).digest("hex");
    if (!unique.has(digest)) {
      const frame = unique.size;
      unique.set(digest, frame);
      await writeFile(path.join(output, `frame-${frame}.png`), bytes);
    }
    samples.push({
      elapsedMs: Date.now() - started,
      width: png.width,
      height: png.height,
      left,
      right,
      top,
      bottom,
      frame: unique.get(digest),
      digest,
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  const foregroundAfter = foreground();
  const allGrounded = samples.every(
    (sample) => sample.bottom === sample.height - 1,
  );
  const noHorizontalDrift =
    new Set(samples.map((sample) => `${sample.left}:${sample.right}`)).size ===
    1;
  const report = {
    date: new Date().toISOString(),
    executable,
    asarSha256: createHash("sha256")
      .update(
        await readFile(path.resolve(executable, "../../Resources/app.asar")),
      )
      .digest("hex"),
    runtime,
    isolatedProfile: true,
    foregroundBefore: before,
    foregroundAfter,
    uniqueFrames: unique.size,
    allGrounded,
    noHorizontalDrift,
    samples,
  };
  await app.close();
  app = undefined;
  report.exitCode = child.exitCode;
  await writeFile(
    path.join(output, "idle-cycle.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  globalThis.console.log(
    JSON.stringify(
      {
        sampleCount: samples.length,
        durationMs: samples.at(-1).elapsedMs,
        uniqueFrames: unique.size,
        allGrounded,
        noHorizontalDrift,
        topRange: [
          Math.min(...samples.map((s) => s.top)),
          Math.max(...samples.map((s) => s.top)),
        ],
        foregroundBefore: before,
        foregroundAfter,
        exitCode: child.exitCode,
      },
      null,
      2,
    ),
  );
  if (
    !allGrounded ||
    !noHorizontalDrift ||
    unique.size < 3 ||
    child.exitCode !== 0
  )
    throw new Error("Packaged idle observation failed");
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
