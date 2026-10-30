import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, inject, onTestFinished, test, vi } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile,
  realpath,
  readFile,
  stat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createObservationSession } from "../tools/observation-session";
import { borrowPreparedApplication } from "./support/preparation";
import { treeDigest } from "../tools/preparation-inputs";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture() {
  const prepared = await borrowPreparedApplication(
    inject("moseyPreparation"),
    "packaged",
  );
  const root = await mkdtemp(
    path.join(os.tmpdir(), "mosey-observation-fixture-"),
  );
  const bundle = path.join(root, "Mosey.app");
  const evidence = path.resolve(
    "test-results/observation-sessions",
    randomUUID(),
  );
  const sessions: Awaited<ReturnType<typeof createObservationSession>>[] = [];
  onTestFinished(async () => {
    try {
      for (const session of sessions.toReversed()) await session.close();
      await rm(root, { recursive: true, force: true });
    } finally {
      await prepared.release();
    }
  });
  execFileSync("/usr/bin/ditto", [prepared.appRoot, bundle], {
    timeout: 30000,
  });
  execFileSync(
    "/usr/libexec/PlistBuddy",
    [
      "-c",
      `Set :CFBundleIdentifier dev.frost.mosey.observation.${randomUUID()}`,
      path.join(bundle, "Contents/Info.plist"),
    ],
    { timeout: 5000 },
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", bundle],
    { timeout: 30000 },
  );
  const before = await treeDigest(bundle);
  return {
    bundle,
    evidence,
    async session(signal?: AbortSignal) {
      const session = await createObservationSession({
        bundle,
        evidence: path.join(evidence, String(sessions.length)),
        signal,
      });
      sessions.push(session);
      return session;
    },
    async unchanged() {
      expect(await treeDigest(bundle)).toBe(before);
      execFileSync(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", bundle],
        { timeout: 30000 },
      );
    },
  };
}

test("original-bundle observation requires actual exit zero even when the quit acknowledgement is lost", async () => {
  const owned = await fixture();
  const session = await owned.session();
  const { app, pet, child } = await session.launch();
  await session.run("paint", () =>
    pet.waitForFunction(() => {
      const canvas = document.querySelector("canvas");
      return !!canvas
        ?.getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((value, i) => i % 4 === 3 && value > 127);
    }),
  );
  const actual = await session.run("original-runtime", () =>
    app.evaluate(({ app, screen }) => ({
      executable: process.execPath,
      profile: app.getPath("userData"),
      argv: process.argv,
      displayScale: screen.getPrimaryDisplay().scaleFactor,
    })),
  );
  const dpr = await session.run("unforced-dpr", () =>
    pet.evaluate(() => devicePixelRatio),
  );
  expect(await realpath(actual.executable)).toBe(
    await realpath(path.join(owned.bundle, "Contents/MacOS/Mosey")),
  );
  expect(await realpath(actual.profile)).toBe(await realpath(session.profile));
  expect(
    actual.argv.some((arg) => arg.startsWith("--force-device-scale-factor")),
  ).toBe(false);
  expect(dpr).toBeGreaterThan(0);
  await writeFile(
    path.join(session.evidence, "unforced-scale.json"),
    JSON.stringify(
      {
        actual,
        dpr,
        claim: "Actual unforced observation only; no 1x/2x matrix claim",
      },
      null,
      2,
    ),
  );
  const evaluate = app.evaluate.bind(app);
  const acknowledgement = vi
    .spyOn(app, "evaluate")
    .mockImplementationOnce((...args) => {
      void evaluate(...args).catch(() => {});
      return new Promise(() => {});
    });
  try {
    const quitting = session.quit();
    void quitting.catch(() => {});
    await expect.poll(() => child.exitCode, { timeout: 10000 }).toBe(0);
    expect(
      await Promise.race([
        quitting.then(() => true),
        pause(1000).then(() => false),
      ]),
    ).toBe(true);
    expect(child.signalCode).toBe(null);
  } finally {
    acknowledgement.mockRestore();
    await session.close();
  }
  const failed = await owned.session();
  const { app: failureApp, child: failureChild } = await failed.launch();
  const realEvaluate = failureApp.evaluate.bind(failureApp);
  const nonzero = vi
    .spyOn(failureApp, "evaluate")
    .mockImplementationOnce(() => realEvaluate(({ app }) => app.exit(17)));
  try {
    await expect(failed.quit()).rejects.toThrow(/code=17/);
    expect(failureChild.exitCode).toBe(17);
    await failed.close();
  } finally {
    nonzero.mockRestore();
  }
  await owned.unchanged();
});

test("an observation deadline cancels later writes and launches while cleanup remains a safety action", async () => {
  const owned = await fixture();
  const session = await owned.session();
  const { app, child } = await session.launch();
  const stalledClose = vi
    .spyOn(app, "close")
    .mockImplementation(() => new Promise(() => {}));
  const sentinel = path.join(session.evidence, "late-intent.txt");
  const operation = session.run(
    "stalled-observation",
    () => app.evaluate(() => new Promise<void>(() => {})),
    { timeout: 100 },
  );
  const result = operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    const failure = await Promise.race([
      result,
      pause(15000).then(() => new Error("observation was not bounded")),
    ]);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/stalled-observation.*100ms/);
    expect(child.signalCode).toBe("SIGKILL");
    await expect(
      session.run("late-write", () => writeFile(sentinel, "late intent")),
    ).rejects.toThrow(/closed|cancelled/);
    await expect(session.launch()).rejects.toThrow(/closed|cancelled/);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    const events = (
      await readFile(path.join(session.evidence, "lifecycle.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.event === "normal-exit-complete")).toBe(
      false,
    );
    expect(events.find((event) => event.event === "first-failure").stage).toBe(
      "stalled-observation",
    );
  } finally {
    stalledClose.mockRestore();
    await session.close();
    await session.close();
  }
  await owned.unchanged();
});

test("cancelling an observation adopts a late application without resuming readiness or later intent", async () => {
  const owned = await fixture();
  const cancellation = new AbortController();
  const session = await owned.session(cancellation.signal);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired!: (value: {
    app: ElectronApplication;
    child: ChildProcess;
  }) => void;
  const available = new Promise<{
    app: ElectronApplication;
    child: ChildProcess;
  }>((resolve) => {
    acquired = resolve;
  });
  const realLaunch = electron.launch.bind(electron);
  const delayed = vi
    .spyOn(electron, "launch")
    .mockImplementationOnce(async (options) => {
      const app = await realLaunch(options);
      acquired({ app, child: app.process() });
      await gate;
      return app;
    });
  const sentinel = path.join(session.evidence, "late-intent.txt");
  const launching = session
    .launch()
    .then(() =>
      session.run("late-intent", () => writeFile(sentinel, "late intent")),
    );
  void launching.catch(() => {});
  const { child } = await available;
  try {
    cancellation.abort(new Error("cancel observation acquisition"));
    release();
    await expect(launching).rejects.toThrow(/cancel/);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(session.profile)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const events = (
      await readFile(path.join(session.evidence, "lifecycle.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.event === "ready")).toBe(false);
  } finally {
    release();
    delayed.mockRestore();
    await session.close();
  }
  const next = await owned.session();
  const running = await next.launch();
  await next.quit();
  expect(running.child.exitCode).toBe(0);
  await owned.unchanged();
});

test("denied observation cleanup preserves the primary failure and retries without touching an unrelated process", async () => {
  const owned = await fixture();
  const session = await owned.session();
  const { app, child } = await session.launch();
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  const kill = process.kill.bind(process);
  const original = new Error("original observation failure");
  const denied = Object.assign(new Error("observation signal denied"), {
    code: "EPERM",
  });
  const signals = vi
    .spyOn(process, "kill")
    .mockImplementation((pid, signal) => {
      if (pid === -child.pid!) throw denied;
      return kill(pid, signal);
    });
  const stalled = vi
    .spyOn(app, "close")
    .mockImplementation(() => new Promise(() => {}));
  try {
    await expect(
      session.run("original-observation", () => Promise.reject(original)),
    ).rejects.toMatchObject({ cause: original });
    expect(kill(child.pid!, 0)).toBe(true);
    expect(kill(unrelated.pid!, 0)).toBe(true);
    expect((await stat(session.profile)).isDirectory()).toBe(true);
    signals.mockRestore();
    stalled.mockRestore();
    await session.close();
    await session.close();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(kill(unrelated.pid!, 0)).toBe(true);
    await expect(stat(session.profile)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const journal = await readFile(
      path.join(session.evidence, "lifecycle.jsonl"),
      "utf8",
    );
    expect(journal).toContain("original observation failure");
    expect(journal).toContain("observation signal denied");
    expect(journal).toContain('"event":"cleanup-failed"');
    expect(journal).toContain('"event":"cleanup-complete"');
  } finally {
    signals.mockRestore();
    stalled.mockRestore();
    try {
      await session.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        kill(-child.pid!, "SIGKILL");
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
      }
      unrelated.kill("SIGKILL");
      if (unrelated.exitCode === null && unrelated.signalCode === null)
        await new Promise<void>((resolve) =>
          unrelated.once("exit", () => resolve()),
        );
    }
  }
  await owned.unchanged();
});
