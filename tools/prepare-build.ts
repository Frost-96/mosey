import { spawn } from "node:child_process";

// Assets write src/assets/generated; native preparation writes build/native
// and its Swift cache. Forge must see both complete before reading either.
const results = await Promise.allSettled(
  ["assets:build", "native:build"].map(
    (script) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn("pnpm", [script], { stdio: "inherit" });
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === 0 && signal === null) resolve();
          else
            reject(
              new Error(`Build preparation ${script} exited ${code}/${signal}`),
            );
        });
      }),
  ),
);
// A failed branch must not leave its sibling writing after the caller starts
// cleanup. Drain both owned commands, including their stdio, before failing.
const failures = results
  .filter((result) => result.status === "rejected")
  .map((result) => result.reason);
if (failures.length)
  throw new AggregateError(failures, "Production build preparation failed");
