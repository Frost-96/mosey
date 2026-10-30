import process from "node:process";
import {
  createObservationSession,
  captureObservationEvidence,
} from "./observation-session.ts";
import { PNG } from "pngjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

// Observe the packaged application's visible output; no product test hooks.
// An isolated profile leaves other running Mosey probes untouched.
const executable = path.resolve(
  "out/Mosey-darwin-arm64/Mosey.app/Contents/MacOS/Mosey",
);
const output = path.resolve("test-results/issue-2-desktop");
const foreground = () => {
  const asn = execFileSync("/usr/bin/lsappinfo", ["front"], {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
  const info = execFileSync(
    "/usr/bin/lsappinfo",
    ["info", "-only", "bundleID", asn],
    { encoding: "utf8", timeout: 5000 },
  );
  return /bundleID="([^"]+)"/.exec(info)?.[1] ?? "unavailable";
};
let app;
let child;
let observation;
let failure;
const run = (label, action, options) => observation.run(label, action, options);
const cancellation = new globalThis.AbortController();
const interrupt = () =>
  cancellation.abort(new Error("Idle observation interrupted by SIGINT"));
const terminate = () =>
  cancellation.abort(new Error("Idle observation interrupted by SIGTERM"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
try {
  await mkdir(output, { recursive: true });
  observation = await createObservationSession({
    bundle: path.resolve(executable, "../../.."),
    evidence: path.join(output, "lifecycle", randomUUID()),
    inheritEnvironment: true,
    signal: cancellation.signal,
  });
  const { profile } = observation;
  const before = await run("foreground-before", async () => foreground());
  const launched = await observation.launch();
  app = launched.app;
  child = launched.child;
  const window = launched.pet;
  await run(
    "window-waitForFunction",
    () =>
      window.waitForFunction(() => {
        const canvas = globalThis.document.querySelector("canvas");
        if (!canvas) return false;
        const data = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        return data.some((value, index) => index % 4 === 3 && value >= 128);
      }),
    { timeout: 30000 },
  );
  const runtime = await run("app-evaluate", () =>
    app.evaluate(({ app }) => ({
      electron: globalThis.process.versions.electron,
      node: globalThis.process.versions.node,
      userData: app.getPath("userData"),
    })),
  );
  if ((await realpath(runtime.userData)) !== (await realpath(profile)))
    throw new Error("Temporary profile isolation was not applied");
  const samples = [];
  const unique = new Map();
  const started = Date.now();
  while (Date.now() - started < 6500) {
    const bytes = await run("window-screenshot", () =>
      window.screenshot({ omitBackground: true }),
    );
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
      await captureObservationEvidence(() =>
        writeFile(path.join(output, `frame-${frame}.png`), bytes),
      );
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
  const foregroundAfter = await run("foreground-after", async () =>
    foreground(),
  );
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
        await run("artifact-digest", () =>
          readFile(path.resolve(executable, "../../Resources/app.asar")),
        ),
      )
      .digest("hex"),
    runtime,
    isolatedProfile: true,
    lifecycleEvidence: observation.evidence,
    foregroundBefore: before,
    foregroundAfter,
    uniqueFrames: unique.size,
    allGrounded,
    noHorizontalDrift,
    samples,
  };
  await observation.quit();
  app = undefined;
  report.exitCode = child.exitCode;
  await captureObservationEvidence(() =>
    writeFile(
      path.join(output, "idle-cycle.json"),
      JSON.stringify(report, null, 2) + "\n",
    ),
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
} catch (error) {
  failure = error;
}
const cleanup = await observation?.close().then(
  () => undefined,
  (error) => ({ error }),
);
process.off("SIGINT", interrupt);
process.off("SIGTERM", terminate);
if (cleanup)
  failure =
    failure === undefined
      ? cleanup.error
      : new AggregateError(
          [failure, cleanup.error],
          "Idle observation and cleanup failed",
          { cause: failure },
        );
if (failure !== undefined) throw failure;
