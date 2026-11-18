import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

// Starts a detached leader with one helper in its process group. The helper
// sees the leader exit through its closed stdin pipe, then runs `helperExit`.
export async function launchLingeringGroup(helperExit: string) {
  const helper = `process.stdin.on('end', () => { ${helperExit} }); process.stdin.resume(); setInterval(() => {}, 1000);`;
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['pipe', 'ignore', 'ignore'] });
    console.log('ready');
    setInterval(() => {}, 1000);
  `,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  await once(leader.stdout!, "data");
  return leader;
}

// Mirrors Playwright: close() resolves as soon as the leader process exits.
export const closeLeader = (leader: ChildProcess) => async () => {
  const exit = once(leader, "exit");
  leader.kill("SIGTERM");
  await exit;
};
