import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type CrashReportRequest = {
  pid: number;
  executable: string;
  launchedAt: number;
  evidenceDirectory: string;
  reportsDirectory?: string;
  timeoutMs?: number;
};

// macOS .ips files contain either one JSON object or a metadata line followed
// by the crash JSON. Ignore every report not owned by this launch.
function belongsToLaunch(bytes: Buffer, pid: number, launchedAt: number) {
  const text = bytes.toString("utf8");
  let report: { pid?: number; captureTime?: string };
  try {
    report = JSON.parse(text);
  } catch {
    report = JSON.parse(text.slice(text.indexOf("\n") + 1));
  }
  const capturedAt = Date.parse(report.captureTime ?? "");
  return report.pid === pid && capturedAt >= launchedAt;
}

export async function collectNativeCrashEvidence({
  pid,
  executable,
  launchedAt,
  evidenceDirectory,
  reportsDirectory = path.join(os.homedir(), "Library/Logs/DiagnosticReports"),
  timeoutMs = 2000,
}: CrashReportRequest): Promise<{ report?: string; unavailable?: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ unavailable: string }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        unavailable: "No matching native crash report before deadline",
      });
    }, timeoutMs);
  });
  const collect = async () => {
    while (!controller.signal.aborted) {
      const entries = await readdir(reportsDirectory, { withFileTypes: true });
      const candidates = entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.startsWith(`${executable}-`) &&
            entry.name.endsWith(".ips"),
        )
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, 16);
      for (const candidate of candidates) {
        if (controller.signal.aborted) break;
        const file = path.join(reportsDirectory, candidate.name);
        try {
          const info = await stat(file);
          if (info.mtimeMs < launchedAt || info.size > 8 * 1024 * 1024)
            continue;
          const bytes = await readFile(file, { signal: controller.signal });
          if (!belongsToLaunch(bytes, pid, launchedAt)) continue;
          controller.signal.throwIfAborted();
          const report = `native-crash-${pid}.ips`;
          await writeFile(path.join(evidenceDirectory, report), bytes, {
            signal: controller.signal,
          });
          return { report };
        } catch {
          // A report can still be incomplete while CrashReporter writes it.
          // A later bounded pass may see it; diagnostics never replace failure.
        }
      }
      if (!controller.signal.aborted)
        await delay(100, undefined, { signal: controller.signal }).catch(
          () => {},
        );
    }
    return { unavailable: "Native crash report collection stopped" };
  };
  try {
    return await Promise.race([
      collect().catch((error: unknown) => ({ unavailable: String(error) })),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
