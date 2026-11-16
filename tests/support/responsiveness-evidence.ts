import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DeadlineExceeded, withinDeadline } from "./deadline.ts";
import { sampleProcess } from "./process-sample-evidence.ts";

type Probe = () => unknown;

export type ProbeResult<T = unknown> = {
  value?: T;
  // The probe did not answer before its deadline.
  unresponsive?: string;
  // The probe answered with an error, or there was nothing to probe.
  unavailable?: string;
};

type Probes = Record<string, Probe | undefined>;

export type ResponsivenessTrace<R extends Probes = Probes> = {
  verdict:
    | "main-unresponsive"
    | "renderer-unresponsive"
    | "responsive"
    | "main-unavailable";
  main: ProbeResult;
  renderers: {
    [Page in keyof R]: ProbeResult<Awaited<ReturnType<NonNullable<R[Page]>>>>;
  };
  sample?: { report?: string; unavailable?: string };
};

async function answer(label: string, probe: Probe | undefined, ms: number) {
  if (!probe) return { unavailable: `${label} is not open` };
  try {
    return { value: await withinDeadline(label, probe, ms) };
  } catch (error) {
    return error instanceof DeadlineExceeded
      ? { unresponsive: error.message }
      : { unavailable: String(error) };
  }
}

// A failed poll cannot tell an application that answered wrongly from one that
// stopped answering. Every CDP command, renderer ones included, is routed by
// the main process's UI thread, so a stalled main thread silences every probe
// while a stalled renderer silences only its own. Any silence keeps the main
// thread's stacks, the only record of what blocked the run. The trace is
// written to `<name>-trace.json` in the evidence directory and returned.
export async function recordResponsiveness<R extends Probes>({
  name,
  evidenceDirectory,
  main,
  renderers,
  deadlineMs = 1000,
  sampleCommand,
}: {
  name: string;
  evidenceDirectory: string;
  main: { pid: number | undefined; probe: Probe };
  // An absent page is recorded as unavailable rather than skipped.
  renderers: R;
  deadlineMs?: number;
  sampleCommand?: string;
}): Promise<ResponsivenessTrace<R>> {
  const [mainResult, ...rendererResults] = await Promise.all([
    answer("Main process probe", main.probe, deadlineMs),
    ...Object.entries(renderers).map(([page, probe]) =>
      answer(`${page} renderer probe`, probe, deadlineMs),
    ),
  ]);
  const rendererTrace = Object.fromEntries(
    Object.keys(renderers).map((page, index) => [
      page,
      rendererResults[index]!,
    ]),
  );
  const silentRenderer = rendererResults.some((result) => result.unresponsive);
  const verdict = mainResult.unresponsive
    ? "main-unresponsive"
    : mainResult.unavailable
      ? "main-unavailable"
      : silentRenderer
        ? "renderer-unresponsive"
        : "responsive";
  const sample =
    main.pid !== undefined && (mainResult.unresponsive || silentRenderer)
      ? await sampleProcess({
          pid: main.pid,
          name: `${name}-main-sample`,
          evidenceDirectory,
          command: sampleCommand,
        })
      : undefined;
  const trace: ResponsivenessTrace<R> = {
    verdict,
    main: mainResult,
    renderers: rendererTrace as ResponsivenessTrace<R>["renderers"],
    ...(sample && { sample }),
  };
  await writeFile(
    path.join(evidenceDirectory, `${name}-trace.json`),
    JSON.stringify(trace, null, 2),
  ).catch(() => {});
  return trace;
}
