import { execFileSync, spawn } from "node:child_process";
import { expect, onTestFinished, test, vi } from "vitest";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  readProcessSnapshot,
  sameProcess,
  isLiveProcess,
} from "../tools/macos-processes";
import { recordMeasurement } from "./support/measurement";
import {
  borrowPreparedApplication,
  createPreparationRun,
} from "./support/preparation";

test("cancellation keeps its original cause when a late release cannot reach the closed run", async () => {
  const owner = await createPreparationRun();
  await owner.close();
  const cancellation = new AbortController();
  const original = new Error("original scenario cancellation");
  const borrowing = borrowPreparedApplication(
    owner.locator,
    "development",
    cancellation.signal,
  );
  cancellation.abort(original);
  const failure = await borrowing.catch((error: unknown) => error);
  expect(failure).toMatchObject({ cause: original });
});

test("cancelling one in-flight borrower preserves the other and closing waits for its release", async () => {
  const eventsFile = path.join(
    process.env.MOSEY_MEASUREMENT_ROOT!,
    process.env.MOSEY_MEASUREMENT_RUN_ID!,
    "events.jsonl",
  );
  const events = async () =>
    (await readFile(eventsFile, "utf8"))
      .split("\n")
      .slice(0, -1)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const before = (await events()).length;
  const owner = await createPreparationRun();
  const cancellation = new AbortController();
  const original = new Error("one scenario cancelled during preparation");
  const cancelled = borrowPreparedApplication(
    owner.locator,
    "development",
    cancellation.signal,
  );
  const rejected = expect(cancelled).rejects.toBe(original);
  const surviving = borrowPreparedApplication(owner.locator, "development");
  onTestFinished(async () => {
    await surviving.then(
      (lease) => lease.release(),
      () => undefined,
    );
    await owner.close();
  });
  await expect
    .poll(async () =>
      (await events())
        .slice(before)
        .some(
          (row) =>
            row.event === "start" && row.phase === "preparation.identify",
        ),
    )
    .toBe(true);
  cancellation.abort(original);
  await rejected;
  const lease = await surviving;
  const main = await readFile(
    path.join(lease.appRoot, ".vite/build/main.mjs"),
    "utf8",
  );
  const url = main.match(/http:\/\/localhost:\d+/)?.[0];
  expect(url).toBeTruthy();
  expect(await (await fetch(url!)).text()).toContain("<title>Mosey</title>");
  const closing = owner.close();
  await expect(
    borrowPreparedApplication(owner.locator, "development"),
  ).rejects.toThrow(/closed/);
  expect(await (await fetch(url!)).text()).toContain("<title>Mosey</title>");
  await lease.release();
  await closing;
  await expect(fetch(url!)).rejects.toThrow();
  await expect(access(lease.appRoot)).rejects.toThrow();
  const prepared = (await events())
    .slice(before)
    .filter((row) => row.event === "end" && row.phase === "forge.prepare");
  expect(prepared).toEqual([
    expect.objectContaining({
      outcome: "passed",
      preparationId: lease.preparationId,
    }),
  ]);
});

test("closing a run during real Forge preparation rejects its pending borrow and reaps the preparation group", async () => {
  const file = path.join(
    process.env.MOSEY_MEASUREMENT_ROOT!,
    process.env.MOSEY_MEASUREMENT_RUN_ID!,
    "events.jsonl",
  );
  const events = async () =>
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const before = (await events()).length;
  const owner = await createPreparationRun();
  const borrowing = borrowPreparedApplication(owner.locator, "development");
  const failure = borrowing.catch((error: unknown) => error);
  onTestFinished(async () => {
    await borrowing.then(
      (lease) => lease.release(),
      () => undefined,
    );
    await owner.close();
  });
  const processes = () =>
    execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,state=,comm="], {
      encoding: "utf8",
      timeout: 5000,
    })
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, parent, group, state, ...command] = line
          .trim()
          .split(/\s+/);
        return {
          pid: Number(pid),
          parent: Number(parent),
          group: Number(group),
          state: state!,
          command: command.join(" "),
        };
      });
  let observed: ReturnType<typeof processes> = [];
  await expect
    .poll(
      async () => {
        const leader = (await events())
          .slice(before)
          .find((row) => row.event === "forge-process")?.groupId;
        if (!leader) return false;
        const table = processes(),
          owned = new Set([leader]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const member of table)
            if (owned.has(member.parent) && !owned.has(member.pid)) {
              owned.add(member.pid);
              changed = true;
            }
        }
        observed = table.filter((member) => owned.has(member.pid));
        return observed.some(
          (member) =>
            member.command.endsWith("swift-frontend") &&
            !member.state.startsWith("Z"),
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  recordMeasurement("forge-cancel-boundary", { descendants: observed });
  const closing = owner.close();
  expect(await failure).toMatchObject({
    message: expect.stringMatching(/closed/),
  });
  await closing;
  await expect(
    access(path.dirname(owner.locator.socketPath)),
  ).rejects.toThrow();
  const rows = (await events()).slice(before);
  const groups = rows
    .filter((row) => row.event === "forge-process")
    .map((row) => row.groupId);
  const live = processes().filter(
    (member) =>
      (observed.some((prior) => prior.pid === member.pid) ||
        observed.some((prior) => prior.group === member.group)) &&
      !member.state.startsWith("Z"),
  );
  recordMeasurement("forge-cancel-survivors", { descendants: live });
  expect(groups).toHaveLength(1);
  expect(live).toEqual([]);
  expect(rows.some((row) => row.event === "preparation-ready")).toBe(false);
});

test.each(["partial", "denied"] as const)(
  "Forge cleanup verifies actual process outcomes after %s group signals",
  async (outcome) => {
    const owner = await createPreparationRun();
    let released = false;
    onTestFinished(async () => {
      if (!released) await owner.close();
    });
    const lease = await borrowPreparedApplication(owner.locator, "development");
    await lease.release();
    const eventsFile = path.join(
      process.env.MOSEY_MEASUREMENT_ROOT!,
      process.env.MOSEY_MEASUREMENT_RUN_ID!,
      "events.jsonl",
    );
    const events = () =>
      readFile(eventsFile, "utf8").then((contents) =>
        contents
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
    const forge = (await events()).find(
      (row) =>
        row.event === "forge-process" &&
        row.preparationId === lease.preparationId,
    );
    const leader: number = forge.processId;
    const shim: string = forge.shim;
    await expect(access(shim)).resolves.toBeUndefined();
    const table = readProcessSnapshot();
    const descendants = (pid: number): typeof table =>
      table
        .filter((row) => row.parent === pid)
        .flatMap((row) => [row, ...descendants(row.pid)]);
    const owned = [
      table.find((row) => row.pid === leader)!,
      ...descendants(leader),
    ];
    const groups = new Set(owned.map((row) => row.group));
    const live = () =>
      readProcessSnapshot().filter(
        (row) =>
          isLiveProcess(row) && owned.some((prior) => sameProcess(prior, row)),
      );
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const kill = process.kill.bind(process);
    const denied = Object.assign(
      new Error("controlled Forge group permission denial"),
      { code: "EPERM" },
    );
    const signals = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) => {
        if (pid < 0 && groups.has(-pid)) {
          if (outcome === "partial") kill(pid, signal);
          throw denied;
        }
        return kill(pid, signal);
      });
    const cleanup = async () => {
      signals.mockRestore();
      // The intentionally denied case leaves real resources for diagnosis.
      // Release only identities observed under this preparation, never names.
      for (const row of live()) {
        try {
          kill(row.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await expect.poll(live, { timeout: 5000 }).toEqual([]);
      await new Promise<void>((resolve) => {
        unrelated.once("exit", () => resolve());
        unrelated.kill("SIGKILL");
      });
      await owner.close().catch(() => {});
      await rm(path.dirname(owner.locator.socketPath), {
        recursive: true,
        force: true,
      });
      await rm(shim, { recursive: true, force: true });
      released = true;
    };
    try {
      if (outcome === "partial") {
        await owner.close();
        await owner.close();
        expect(live()).toEqual([]);
        await expect(access(lease.appRoot)).rejects.toThrow();
      } else {
        const failure = await owner.close().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        const errors = failure instanceof AggregateError ? failure.errors : [];
        expect(
          errors.flatMap((error: unknown) =>
            error instanceof AggregateError ? error.errors : [error],
          ),
        ).toContain(denied);
        expect(live().length).toBeGreaterThan(0);
        await expect(access(lease.appRoot)).resolves.toBeUndefined();
      }
      expect(kill(unrelated.pid!, 0)).toBe(true);
      expect(
        (await events()).some(
          (row) =>
            row.event === "forge-group-signal-denied" &&
            row.preparationId === lease.preparationId,
        ),
      ).toBe(true);
      signals.mockRestore();
      await owner.close();
      await owner.close();
      expect(live()).toEqual([]);
      await expect(access(lease.appRoot)).rejects.toThrow();
      await expect(access(shim)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  },
);
