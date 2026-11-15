import { execFile } from "node:child_process";
import path from "node:path";

type SampleRequest = {
  pid: number;
  name: string;
  evidenceDirectory: string;
  seconds?: number;
  command?: string;
  timeoutMs?: number;
};

// An application that stops answering its driver leaves no trace of its own.
// macOS `sample` reads the stalled process from outside, including its main
// thread, so the stack that blocked the run is kept as evidence.
export function sampleProcess({
  pid,
  name,
  evidenceDirectory,
  seconds = 2,
  command = "/usr/bin/sample",
  // Sampling is followed by symbolication; diagnostics stay bounded so the
  // failing test still reaches its cleanup.
  timeoutMs = 15000,
}: SampleRequest): Promise<{ report?: string; unavailable?: string }> {
  const report = `${name}-${pid}.txt`;
  return new Promise((resolve) => {
    execFile(
      command,
      [
        String(pid),
        String(seconds),
        "-file",
        path.join(evidenceDirectory, report),
      ],
      { timeout: timeoutMs, killSignal: "SIGKILL" },
      (error) =>
        resolve(
          !error
            ? { report }
            : {
                unavailable: error.killed
                  ? `Process sample exceeded its ${timeoutMs}ms deadline`
                  : String(error),
              },
        ),
    );
  });
}
