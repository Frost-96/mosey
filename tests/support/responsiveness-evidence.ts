import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication } from "playwright";
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
  sample?: Awaited<ReturnType<typeof sampleProcess>>;
};

async function probeWithinDeadline(
  label: string,
  probe: Probe | undefined,
  deadlineMs: number,
): Promise<ProbeResult> {
  if (!probe) return { unavailable: `${label} is not open` };
  try {
    return { value: await withinDeadline(label, probe, deadlineMs) };
  } catch (error) {
    return error instanceof DeadlineExceeded
      ? { unresponsive: error.message }
      : { unavailable: String(error) };
  }
}

// Inspector evaluation can still be answered between the queued callbacks of a
// main thread that has stopped routing renderer traffic (#121). Only a
// completed turn of its event loop shows the main thread is free; the
// evidence is read after that turn.
export const afterMainLoopTurn =
  (app: Pick<ElectronApplication, "evaluate">, evidence?: Probe): Probe =>
  async () => {
    await app.evaluate(
      () => new Promise<void>((resolve) => setImmediate(resolve)),
    );
    return evidence?.();
  };

// A failed poll cannot tell an application that answered wrongly from one that
// stopped answering. A stalled main thread silences every renderer probe too,
// since it routes their CDP traffic; a stalled renderer silences only its own.
// Any silence keeps the main thread's stacks, the only record of what blocked
// the run. The trace is kept as `<name>-trace.json` beside the stacks.
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
  // An absent application or page is recorded as unavailable, never skipped.
  // The main probe must answer only after a main loop turn: afterMainLoopTurn.
  main: { pid: number | undefined; probe: Probe | undefined };
  renderers: R;
  deadlineMs?: number;
  sampleCommand?: string;
}): Promise<ResponsivenessTrace<R>> {
  const [mainResult, rendererEntries] = await Promise.all([
    probeWithinDeadline("Main process probe", main.probe, deadlineMs),
    Promise.all(
      Object.entries(renderers).map(
        async ([page, probe]) =>
          [
            page,
            await probeWithinDeadline(
              `${page} renderer probe`,
              probe,
              deadlineMs,
            ),
          ] as const,
      ),
    ),
  ]);
  const silentRenderer = rendererEntries.some(
    ([, result]) => result.unresponsive,
  );
  const verdict = mainResult.unresponsive
    ? "main-unresponsive"
    : silentRenderer
      ? "renderer-unresponsive"
      : mainResult.unavailable
        ? "main-unavailable"
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
    renderers: Object.fromEntries(
      rendererEntries,
    ) as ResponsivenessTrace<R>["renderers"],
    ...(sample && { sample }),
  };
  await writeFile(
    path.join(evidenceDirectory, `${name}-trace.json`),
    JSON.stringify(trace, null, 2),
  ).catch(() => {});
  return trace;
}
