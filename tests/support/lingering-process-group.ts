import { spawn } from "node:child_process";
import { once } from "node:events";

// Starts a detached leader with one helper in its process group. The helper
// sees the leader exit through its closed stdin pipe, then exits after
// `helperExitMs`; without it the helper outlives the leader indefinitely.
export async function launchLingeringGroup(helperExitMs?: number) {
  const onLeaderExit =
    helperExitMs === undefined
      ? ""
      : `setTimeout(() => process.exit(0), ${helperExitMs});`;
  const helper = `process.stdin.on('end', () => { ${onLeaderExit} }); process.stdin.resume(); setInterval(() => {}, 1000);`;
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
