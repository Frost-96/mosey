import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

export type ProcessIdentity = { pid: number; start: string };
export type MacOSProcess = ProcessIdentity & {
  parent: number;
  group: number;
  state: string;
  command: string;
};

const fields = ["-axo", "pid=,ppid=,pgid=,lstart=,state=,args="];
const options = () => ({
  encoding: "utf8" as const,
  timeout: 5000,
  env: { ...process.env, LC_ALL: "C" },
});
const parse = (output: string): MacOSProcess[] =>
  output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const values = line.trim().split(/\s+/);
      return {
        pid: Number(values[0]),
        parent: Number(values[1]),
        group: Number(values[2]),
        start: values.slice(3, 8).join(" "),
        state: values[8]!,
        command: values.slice(9).join(" "),
      };
    });

export const readProcessSnapshot = () =>
  parse(execFileSync("/bin/ps", fields, options()));

const execute = promisify(execFile);
export const readProcessSnapshotAsync = async () =>
  parse((await execute("/bin/ps", fields, options())).stdout);

export const sameProcess = (
  expected: ProcessIdentity | undefined,
  current: ProcessIdentity,
) => expected?.pid === current.pid && expected.start === current.start;

// A zombie cannot execute or retain application resources. Owners still wait
// for their ChildProcess exit event independently of this process-table view.
export const isLiveProcess = (member: MacOSProcess) =>
  !member.state.startsWith("Z");

export function liveProcessGroup(
  rows: MacOSProcess[],
  group: number,
  leader: ProcessIdentity | undefined,
) {
  const current = rows.find((row) => row.pid === group);
  const members = rows.filter(
    (row) => row.group === group && isLiveProcess(row),
  );
  if ((current && !sameProcess(leader, current)) || (members.length && !leader))
    throw new Error(
      "Owned process identity is unavailable or changed; refusing to signal another process",
    );
  return members;
}

// The owner selects membership (one app group or Forge's observed ancestry).
// Recheck a member's birth identity immediately before signalling that group.
// This is a conservative snapshot guard, not an atomic kernel process handle.
// EPERM remains the owner's decision: macOS can partially deliver a group signal.
export function signalProcessGroup(
  members: MacOSProcess[],
  signal: NodeJS.Signals,
) {
  if (!members.length) return false;
  const group = members[0]!.group;
  if (
    !Number.isInteger(group) ||
    group <= 1 ||
    members.some((member) => member.group !== group)
  )
    throw new Error("Invalid owned process group");
  const current = readProcessSnapshot();
  if (
    !current.some(
      (row) =>
        row.group === group &&
        isLiveProcess(row) &&
        members.some((member) => sameProcess(member, row)),
    )
  )
    return false;
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}
