import type { ElectronApplication } from "playwright";
import {
  createObservationSession,
  captureObservationEvidence,
  observationError,
} from "./observation-session.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

// Opt-in observation of the shipped app. No thresholds, fake clocks, native
// substitutes, or product hooks. Playwright input is not physical input evidence.
const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "60" },
    "growth-seconds": { type: "string", default: "300" },
    app: { type: "string", default: "out/Mosey-darwin-arm64/Mosey.app" },
    output: { type: "string" },
  },
});
const seconds = Number(values.seconds);
const growthSeconds = Number(values["growth-seconds"]);
if (
  !Number.isInteger(seconds) ||
  seconds < 10 ||
  seconds > 3600 ||
  !Number.isInteger(growthSeconds) ||
  growthSeconds < 0 ||
  growthSeconds > 86400
)
  throw new Error("Use --seconds 10..3600 and --growth-seconds 0..86400");
const bundle = path.resolve(values.app);
const output = path.resolve(
  values.output ?? `test-results/resources-${Date.now()}`,
);
await mkdir(path.dirname(output), { recursive: true });
// A run is evidence for one artifact; never silently replace an earlier report.
await mkdir(output);
const command = (file: string, args: string[]) =>
  execFileSync(file, args, { encoding: "utf8", timeout: 5000 }).trim();
const digest = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function processTree(root: number) {
  const rows = command("/bin/ps", ["-axo", "pid=,ppid=,rss=,time=,comm="])
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(.+)$/.exec(line);
      if (!match) throw new Error(`Unrecognized ps row: ${line}`);
      const cpuSeconds = match[4]
        .split(":")
        .reduce((total, part) => total * 60 + Number(part), 0);
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        rssKiB: Number(match[3]),
        cpuSeconds,
        executable: path.basename(match[5]),
      };
    });
  const owned = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.parent) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => owned.has(row.pid));
}

interface Sample {
  phase: string;
  elapsedSeconds: number;
  phaseElapsedSeconds: number;
  intervalSeconds: number;
  posture: string;
  actionId: number;
  stablePosture: boolean;
  visibility: string;
  dockStatus: string | undefined;
  stableDockStatus: boolean;
  cpuPercentOneCore: number;
  rssMiB: number;
  processes: (ReturnType<typeof processTree>[number] & {
    cpuSecondsDelta: number;
  })[];
  drawing: { count: number; gapsMs: number[]; inputToDrawMs: number[] };
}
const samples: Sample[] = [];
function summarize(group: Sample[]) {
  const latency = group
    .flatMap((sample) => sample.drawing.inputToDrawMs)
    .sort((a, b) => a - b);
  const elapsed = group.reduce(
    (sum, sample) => sum + sample.intervalSeconds,
    0,
  );
  return {
    samples: group.length,
    measuredSeconds: elapsed,
    cpuPercentOneCoreMean: elapsed
      ? group.reduce(
          (sum, sample) =>
            sum + sample.cpuPercentOneCore * sample.intervalSeconds,
          0,
        ) / elapsed
      : null,
    rssMiBFirst: group[0]?.rssMiB ?? null,
    rssMiBLast: group.at(-1)?.rssMiB ?? null,
    rssMiBMax: group.length
      ? Math.max(...group.map((sample) => sample.rssMiB))
      : null,
    byExecutable: Object.fromEntries(
      [
        ...new Set(
          group.flatMap((sample) => sample.processes.map((p) => p.executable)),
        ),
      ].map((executable) => {
        const processes = group.flatMap((sample) =>
          sample.processes.filter((p) => p.executable === executable),
        );
        return [
          executable,
          {
            observedPids: [...new Set(processes.map((p) => p.pid))],
            cpuPercentOneCoreMean: elapsed
              ? (processes.reduce((sum, p) => sum + p.cpuSecondsDelta, 0) /
                  elapsed) *
                100
              : null,
            rssMiBMax: Math.max(
              0,
              ...group.map(
                (sample) =>
                  sample.processes
                    .filter((p) => p.executable === executable)
                    .reduce((sum, p) => sum + p.rssKiB, 0) / 1024,
              ),
            ),
          },
        ];
      }),
    ),
    inputSamples: latency.length,
    inputToDrawMsP95: latency.length
      ? latency[Math.ceil(latency.length * 0.95) - 1]
      : null,
    draws: group.reduce((sum, sample) => sum + sample.drawing.count, 0),
    postures: [...new Set(group.map((sample) => sample.posture))],
    dockStatuses: [...new Set(group.map((sample) => sample.dockStatus))],
  };
}
const report: Record<string, unknown> = {
  schemaVersion: 2,
  completed: false,
  startedAt: new Date().toISOString(),
  parameters: { seconds, growthSeconds, bundle },
  budget: "pending user confirmation",
  methods: {
    cpu: "Delta of ps cumulative CPU time over wall time, summed over the app process tree including Swift helpers; 100% is one core. Exited children between samples can be missed; ps time resolution is 10 ms.",
    memory:
      "Sum of process-tree RSS; shared pages may be counted more than once. This is not unique physical footprint.",
    input:
      "Renderer pointerdown dispatch to next Canvas drawImage, driven by Playwright. Excludes physical input, compositor and display latency; not a real-input acceptance result.",
    drawing:
      "Canvas draw intervals, not display FPS. Idle animation deliberately redraws infrequently; these gaps are not dropped frames.",
    overhead:
      "Playwright inspector attached, one sample per second; ps and probe overhead included. No concurrent test suite should run.",
    posture:
      "Posture summaries include only intervals whose action ID and visibility stayed unchanged at both endpoints; phase summaries include transitions.",
    growth:
      "Undisturbed visible session after other phases, summarized in 60-second buckets. Samples are assigned by interval end; a bucket may be partial. RSS changes do not prove a leak or long-term stability.",
    dock: "Dock status sampled from the application menu. Group only intervals with matching endpoint statuses; unseen transitions are possible. Active-status samples are not visual contour or physical Dock acceptance.",
  },
  energy: {
    status: "not measured",
    reason:
      "No per-app energy instrument used; CPU is not an energy measurement.",
  },
  droppedFrames: {
    status: "not measured",
    reason:
      "Requires compositor/display measurement; Canvas calls alone do not establish presentation.",
  },
  samples,
};
async function saveReport() {
  const file = path.join(output, "resources.json");
  // An interrupted write must leave the previous complete checkpoint readable.
  await captureObservationEvidence(() =>
    writeFile(`${file}.tmp`, JSON.stringify(report, null, 2) + "\n"),
  );
  await captureObservationEvidence(() => rename(`${file}.tmp`, file));
}
let app: ElectronApplication | undefined;
let primaryFailure: unknown;
let observation:
  Awaited<ReturnType<typeof createObservationSession>> | undefined;
const run = <T>(
  label: string,
  action: () => Promise<T>,
  options?: { timeout?: number },
) => observation!.run(label, action, options);
const cancellation = new AbortController();
const interrupt = () =>
  cancellation.abort(new Error("Resource observation interrupted by SIGINT"));
const terminate = () =>
  cancellation.abort(new Error("Resource observation interrupted by SIGTERM"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
try {
  observation = await createObservationSession({
    bundle,
    evidence: path.join(output, "lifecycle"),
    signal: cancellation.signal,
  });
  report.lifecycleEvidence = observation.evidence;
  report.measurementTool = {
    sourceSHA256: await digest(fileURLToPath(import.meta.url)),
    ownerSHA256: await digest(
      fileURLToPath(new URL("./observation-session.ts", import.meta.url)),
    ),
    node: process.versions.node,
    // These identify the measurement environment, not the packaged app's source.
    dependencyLockSHA256: await digest(path.resolve("pnpm-lock.yaml")),
  };
  report.artifact = {
    asarSHA256: await digest(path.join(bundle, "Contents/Resources/app.asar")),
    nativeSHA256: await digest(
      path.join(bundle, "Contents/Resources/native/dock-runtime"),
    ),
    minimumSystemVersion: command("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :LSMinimumSystemVersion",
      path.join(bundle, "Contents/Info.plist"),
    ]),
  };
  report.host = {
    macOS: command("/usr/bin/sw_vers", ["-productVersion"]),
    build: command("/usr/bin/sw_vers", ["-buildVersion"]),
    model: command("/usr/sbin/sysctl", ["-n", "hw.model"]),
    chip: command("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
    memoryBytes: Number(command("/usr/sbin/sysctl", ["-n", "hw.memsize"])),
    powerSource: command("/usr/bin/pmset", ["-g", "batt"]),
  };
  const launched = await observation.launch();
  app = launched.app;
  const { child, pet } = launched;
  const pid = child.pid!;
  await run(
    "pet-waitForFunction",
    () =>
      pet.waitForFunction(() => {
        const canvas = document.querySelector("canvas");
        return (
          canvas &&
          canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height)
            .data.some((value, index) => index % 4 === 3 && value > 127)
        );
      }),
    { timeout: 30000 },
  );
  report.runtime = await run("app-evaluate", () =>
    app!.evaluate(({ app, screen }) => ({
      versions: process.versions,
      packaged: app.isPackaged,
      displays: screen
        .getAllDisplays()
        .map(({ bounds, workArea, scaleFactor, displayFrequency }) => ({
          bounds,
          workArea,
          scaleFactor,
          displayFrequency,
        })),
    })),
  );
  report.initialPresentation = await run("pet-evaluate", () =>
    pet.evaluate(() => window.mosey.getPresentation()),
  );
  await run("pet-evaluate", () =>
    pet.evaluate(() => {
      const probe = {
        count: 0,
        gapsMs: [] as number[],
        inputToDrawMs: [] as number[],
      };
      Reflect.set(window, "resourceProbe", probe);
      let last = 0;
      let pressed: number | undefined;
      window.addEventListener(
        "pointerdown",
        () => {
          pressed = performance.now();
        },
        true,
      );
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      Reflect.set(
        CanvasRenderingContext2D.prototype,
        "drawImage",
        function (this: CanvasRenderingContext2D, ...args: unknown[]) {
          const now = performance.now();
          probe.count++;
          if (last) probe.gapsMs.push(now - last);
          if (pressed !== undefined) {
            probe.inputToDrawMs.push(now - pressed);
            pressed = undefined;
          }
          last = now;
          return Reflect.apply(draw, this, args);
        },
      );
    }),
  );
  const menu = (label: string) =>
    run("app-evaluate", () =>
      app!.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()!
          .items.find((item) => item.label === "Mosey")!
          .submenu!.items.find((item) => item.label === label);
        if (!item) throw new Error(`Missing menu item: ${label}`);
        item.click();
      }, label),
    );
  const started = performance.now();
  const dockStatus = () =>
    run("app-evaluate", () =>
      app!.evaluate(
        ({ Menu }) =>
          Menu.getApplicationMenu()?.getMenuItemById("dock-runtime-status")
            ?.label,
      ),
    );
  let previousAt = started;
  let previous = await run("process-sample", async () => processTree(pid));
  for (const [phase, duration] of [
    ["undisturbed", seconds],
    ["interaction", seconds],
    ["dragging", seconds],
    ["hidden", seconds],
    ["growth", growthSeconds],
  ] as const) {
    if (!duration) continue;
    console.log(`Resource phase: ${phase}, ${duration}s`);
    if (phase === "dragging") {
      // Begin on a fresh resting frame, not a moving reaction's transparent area.
      await menu("Hide Mosey");
      await menu("Show Mosey");
      await pause(600);
      await run("pet-move", () => pet.mouse.move(80, 120));
      await run("pet-down", () => pet.mouse.down());
      // Move sideways before lifting so the native cursor is less likely to
      // cross the moving window and cancel Chromium's synthetic capture.
      await run("pet-move", () => pet.mouse.move(180, 120, { steps: 6 }));
      await run("pet-move", () => pet.mouse.move(80, -80, { steps: 6 }));
    } else if (phase === "hidden") {
      await run("pet-up", () => pet.mouse.up());
      await menu("Hide Mosey");
    } else if (phase === "growth") await menu("Show Mosey");
    // Exclude menu/gesture setup from the next phase's CPU and draw counters.
    await run("pet-evaluate", () =>
      pet.evaluate(() => {
        const probe = Reflect.get(window, "resourceProbe") as Sample["drawing"];
        probe.count = 0;
        probe.gapsMs.length = 0;
        probe.inputToDrawMs.length = 0;
      }),
    );
    previous = await run("process-sample", async () => processTree(pid));
    previousAt = performance.now();
    let previousPresentation: { actionId: number; visibility: string } =
      await run("pet-evaluate", () =>
        pet.evaluate(() => window.mosey.getPresentation()),
      );
    let previousDockStatus = await dockStatus();
    const phaseStarted = performance.now();
    let nextCheckpoint = phaseStarted + 30000;
    let step = 0;
    while (performance.now() - phaseStarted < duration * 1000) {
      if (phase === "interaction" && step % 2 === 0)
        await run("pet-click", () => pet.mouse.click(80, 120));
      if (phase === "dragging")
        await run("pet-move", () => pet.mouse.move(step % 2 ? 85 : 75, 80));
      await pause(1000);
      const at = performance.now();
      const processes = (
        await run("process-sample", async () => processTree(pid))
      ).map((row) => ({
        ...row,
        cpuSecondsDelta: Math.max(
          0,
          row.cpuSeconds -
            (previous.find((old) => old.pid === row.pid)?.cpuSeconds ?? 0),
        ),
      }));
      const intervalSeconds = (at - previousAt) / 1000;
      const cpuDelta = processes.reduce(
        (sum, row) => sum + row.cpuSecondsDelta,
        0,
      );
      const state = await run("pet-evaluate", () =>
        pet.evaluate(async () => {
          const state = await window.mosey.getPresentation();
          const probe = Reflect.get(
            window,
            "resourceProbe",
          ) as Sample["drawing"];
          const drawing = {
            count: probe.count,
            gapsMs: probe.gapsMs.splice(0),
            inputToDrawMs: probe.inputToDrawMs.splice(0),
          };
          probe.count = 0;
          return {
            posture: state.posture,
            actionId: state.actionId,
            visibility: state.visibility,
            drawing,
          };
        }),
      );
      if (phase === "dragging" && state.posture !== "dragging")
        throw new Error(
          `Dragging sample lost its gesture (${state.posture}); repeat without interacting with the desktop`,
        );
      if (phase === "hidden" && state.visibility !== "hidden")
        throw new Error("Hidden sample became visible");
      const currentDockStatus = await dockStatus();
      samples.push({
        phase,
        elapsedSeconds: (at - started) / 1000,
        phaseElapsedSeconds: (at - phaseStarted) / 1000,
        intervalSeconds,
        ...state,
        stablePosture:
          state.actionId === previousPresentation.actionId &&
          state.visibility === previousPresentation.visibility,
        dockStatus: currentDockStatus,
        stableDockStatus: currentDockStatus === previousDockStatus,
        cpuPercentOneCore: (cpuDelta / intervalSeconds) * 100,
        rssMiB: processes.reduce((sum, row) => sum + row.rssKiB, 0) / 1024,
        processes,
      });
      previous = processes;
      previousAt = at;
      previousPresentation = state;
      previousDockStatus = currentDockStatus;
      step++;
      if (at >= nextCheckpoint) {
        await saveReport();
        console.log(
          `Resource checkpoint: ${phase}, ${Math.round((at - phaseStarted) / 1000)}s`,
        );
        nextCheckpoint = at + 30000;
      }
    }
    await saveReport();
  }
  const exit = await observation.quit();
  app = undefined;
  report.exitCode = exit.exitCode;
  report.exitSignal = exit.signal;
  report.remainingPids = exit.remainingPids;
  report.completed = true;
} catch (error) {
  primaryFailure = error;
  report.completed = false;
  report.error = String(error);
  report.failure = observationError(error);
  await captureObservationEvidence(async () => {
    await app?.windows()[0]?.screenshot({
      path: path.join(output, "failure.png"),
      timeout: 3000,
    });
  }).catch((error) => {
    report.evidenceFailure = observationError(error);
  });
  process.exitCode = 1;
}
try {
  await observation?.close();
} catch (error) {
  report.completed = false;
  report.cleanupFailure = observationError(error);
  process.exitCode = 1;
}
report.finishedAt = new Date().toISOString();
report.summary = Object.fromEntries(
  [...new Set(samples.map((sample) => sample.phase))].map((phase) => [
    phase,
    summarize(samples.filter((sample) => sample.phase === phase)),
  ]),
);
const stableDockSamples = samples.filter((sample) => sample.stableDockStatus);
report.byDockStatus = Object.fromEntries(
  [
    ...new Set(
      stableDockSamples.map((sample) => sample.dockStatus ?? "Unknown"),
    ),
  ].map((status) => [
    status,
    summarize(
      stableDockSamples.filter(
        (sample) => (sample.dockStatus ?? "Unknown") === status,
      ),
    ),
  ]),
);
const activeDockSamples = stableDockSamples.filter(
  (sample) => sample.dockStatus === "Dock interaction active",
);
report.dockCoverage = {
  activeStatusSamples: activeDockSamples.length,
  activeStatusSeconds: activeDockSamples.reduce(
    (sum, sample) => sum + sample.intervalSeconds,
    0,
  ),
  conclusion: activeDockSamples.length
    ? "Active capture status observed; visual geometry and sustained capture still require separate evidence."
    : "No stable active-capture interval observed; this run does not measure the cost of working Dock interaction.",
};
const growth = samples.filter((sample) => sample.phase === "growth");
report.growthWindows = [
  ...new Set(
    growth.map((sample) => Math.floor(sample.phaseElapsedSeconds / 60)),
  ),
].map((minute) => ({
  fromSeconds: minute * 60,
  toSeconds: (minute + 1) * 60,
  ...summarize(
    growth.filter(
      (sample) => Math.floor(sample.phaseElapsedSeconds / 60) === minute,
    ),
  ),
}));
const stableSamples = samples.filter((sample) => sample.stablePosture);
report.byPosture = Object.fromEntries(
  [
    ...new Set(
      stableSamples.map((sample) => `${sample.visibility}:${sample.posture}`),
    ),
  ].map((key) => [
    key,
    summarize(
      stableSamples.filter(
        (sample) => `${sample.visibility}:${sample.posture}` === key,
      ),
    ),
  ]),
);
const evidenceFailure = await saveReport().then(
  () => undefined,
  (error: unknown) => ({ error }),
);
process.off("SIGINT", interrupt);
process.off("SIGTERM", terminate);
if (evidenceFailure) {
  if (primaryFailure !== undefined)
    throw new AggregateError(
      [primaryFailure, evidenceFailure.error],
      "Resource observation and evidence failed",
      { cause: primaryFailure },
    );
  throw evidenceFailure.error;
}
console.log(path.join(output, "resources.json"));
