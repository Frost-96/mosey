import { expect, test, vi } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { advanceRest } from "./support/controlled-behavior";
import { _electron as electron, type ElectronApplication } from "playwright";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("permission-denied cleanup keeps the original failure and can be safely retried", async () => {
  // A destructive fault must not leave macOS restoration history on the
  // default application identity used by later independent sessions.
  const session = await createPetTestSession({
    dock: "empty",
    isolateAppIdentity: true,
  });
  const { app } = await session.launch();
  const child = app.process();
  const original = new Error("original scenario assertion");
  const kill = process.kill.bind(process);
  const denied = Object.assign(new Error("operation not permitted"), {
    code: "EPERM",
  });
  const signals = vi
    .spyOn(process, "kill")
    .mockImplementation((pid, signal) => {
      if (pid === -child.pid!) throw denied;
      return kill(pid, signal);
    });
  const driver = vi
    .spyOn(app, "close")
    .mockImplementation(() => new Promise(() => {}));
  try {
    await expect(
      session.run("original-scenario-failure", () => Promise.reject(original)),
    ).rejects.toMatchObject({ cause: original });
    expect(kill(child.pid!, 0)).toBe(true);
    signals.mockRestore();
    driver.mockRestore();
    await session.close();
    await session.close();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally {
    signals.mockRestore();
    driver.mockRestore();
    if (child.exitCode === null && child.signalCode === null) {
      kill(-child.pid!, "SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
});

test("partial group signalling succeeds only after owned processes exit and leaves unrelated processes alive", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    isolateAppIdentity: true,
  });
  const { app } = await session.launch();
  const child = app.process();
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  const kill = process.kill.bind(process);
  const signals = vi
    .spyOn(process, "kill")
    .mockImplementation((pid, signal) => {
      const result = kill(pid, signal);
      if (pid === -child.pid!)
        throw Object.assign(new Error("partial group signal"), {
          code: "EPERM",
        });
      return result;
    });
  const driver = vi
    .spyOn(app, "close")
    .mockImplementation(() => new Promise(() => {}));
  try {
    await session.close();
    await session.close();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(kill(unrelated.pid!, 0)).toBe(true);
    expect(
      await readFile(path.join(session.evidence, "progress.jsonl"), "utf8"),
    ).toContain('"event":"group-signal-partial"');
  } finally {
    signals.mockRestore();
    driver.mockRestore();
    unrelated.kill("SIGKILL");
    await new Promise<void>((resolve) =>
      unrelated.once("exit", () => resolve()),
    );
  }
});

test("normal exit succeeds even when the driver acknowledgement never arrives", async () => {
  const session = await createPetTestSession({ dock: "empty" });
  const { app } = await session.launch();
  const child = app.process();
  const evaluate = app.evaluate.bind(app);
  const stalled = vi.spyOn(app, "evaluate").mockImplementation((...args) => {
    void evaluate(...args).catch(() => {});
    return new Promise(() => {});
  });
  try {
    await session.quit();
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBe(null);
    await session.close();
    await session.close();
  } finally {
    stalled.mockRestore();
  }
});

test("a failing requested quit action is rejected before the next independent session", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    isolateAppIdentity: true,
  });
  const { app } = await session.launch();
  const child = app.process();
  // Fault the public process boundary. A different successful menu command
  // must never stand in for the caller's chosen action or its real exit status.
  await expect(
    session.quit({ action: () => app.evaluate(({ app }) => app.exit(17)) }),
  ).rejects.toThrow(/normal-exit failed: code=17/);
  expect(child.exitCode).toBe(17);
  expect(child.signalCode).toBe(null);
  await expect(
    readFile(path.join(session.profile, "preferences.json"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(session.launch()).rejects.toThrow(/closed|cancelled/);

  const next = await createPetTestSession({ dock: "empty" });
  const launched = await next.launch();
  // Retain the real process before Quit can dispose the driver's lookup.
  const nextChild = launched.app.process();
  expect(
    await next.run("next-visible-pet", () =>
      launched.pet.evaluate(
        async () => (await window.mosey.getPresentation()).visibility,
      ),
    ),
  ).toBe("visible");
  await next.quit();
  await next.close();
  expect(nextChild.exitCode).toBe(0);
  expect(nextChild.signalCode).toBe(null);
  await expect(readdir(next.profile)).rejects.toMatchObject({ code: "ENOENT" });
});

test("cancellation during preparation releases its profile and the next session is independent", async () => {
  const before = new Set(await readdir(os.tmpdir()));
  const controller = new AbortController();
  const preparing = createPetTestSession({
    dock: "empty",
    signal: controller.signal,
  });
  // The root is still being acquired asynchronously. It must be released even
  // though cancellation happens before the caller can receive a session.
  controller.abort(new Error("cancel during preparation"));
  await expect(preparing).rejects.toThrow(/cancel/);
  expect(
    (await readdir(os.tmpdir())).filter(
      (name) => name.startsWith("mosey-pet-session-") && !before.has(name),
    ),
  ).toEqual([]);
  const next = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      visibility: "hidden",
      size: 160,
    },
  });
  const { renderer } = await next.launch();
  expect((await renderer.read())!.presentation.visibility).toBe("hidden");
  await next.quit();
});

test("cancellation during document readiness stops its pending driver call", async () => {
  const controller = new AbortController();
  const session = await createPetTestSession({
    dock: "empty",
    signal: controller.signal,
    isolateAppIdentity: true,
  });
  const waiting = deferred<ElectronApplication>();
  const launch = electron.launch.bind(electron);
  const delayed = vi
    .spyOn(electron, "launch")
    .mockImplementation(async (options) => {
      const app = await launch(options);
      vi.spyOn(app, "firstWindow").mockImplementation(() => {
        waiting.resolve(app);
        return new Promise(() => {});
      });
      return app;
    });
  try {
    const launching = session.launch();
    const app = await waiting.promise;
    const child = app.process();
    controller.abort(new Error("cancel during readiness"));
    await expect(launching).rejects.toThrow(/cancel/);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await session.close();
  } finally {
    delayed.mockRestore();
  }
});

test("cancellation adopts a late application and never resumes readiness", async () => {
  const controller = new AbortController();
  const session = await createPetTestSession({
    dock: "empty",
    signal: controller.signal,
    isolateAppIdentity: true,
  });
  const acquired = deferred<ElectronApplication>();
  const release = deferred<void>();
  const launch = electron.launch.bind(electron);
  const delayed = vi
    .spyOn(electron, "launch")
    .mockImplementation(async (options) => {
      const app = await launch(options);
      acquired.resolve(app);
      await release.promise;
      return app;
    });
  try {
    const launching = session.launch();
    const app = await acquired.promise;
    const child = app.process();
    controller.abort(new Error("cancel during launch"));
    release.resolve();
    await expect(launching).rejects.toThrow(/cancel/);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await expect(session.launch()).rejects.toThrow(/closed|cancelled/);
    await session.close();
  } finally {
    release.resolve();
    delayed.mockRestore();
  }
});

test("a launch deadline adopts the application when its driver returns late", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    isolateAppIdentity: true,
  });
  const acquired = deferred<ElectronApplication>();
  const release = deferred<void>();
  const launch = electron.launch.bind(electron);
  const delayed = vi
    .spyOn(electron, "launch")
    .mockImplementation(async (options) => {
      const app = await launch({ ...options, timeout: 30000 });
      acquired.resolve(app);
      await release.promise;
      return app;
    });
  try {
    const launching = session.launch({ timeout: 100 });
    const app = await acquired.promise;
    const child = app.process();
    release.resolve();
    await expect(launching).rejects.toThrow(/launch.*100ms/);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await session.close();
  } finally {
    release.resolve();
    delayed.mockRestore();
  }
});

test("an interaction deadline stops the driver and preserves its first failing stage", async () => {
  // Keep the default identity: preceding destructive sessions must leave this
  // application's startup free of their crash-recovery prompts.
  const session = await createPetTestSession({ dock: "empty" });
  const { app } = await session.launch();
  const child = app.process();
  const operation = session.run(
    "stalled-interaction",
    () => app.evaluate(() => new Promise<void>(() => {})),
    { timeout: 100 },
  );
  await expect(operation).rejects.toThrow(/stalled-interaction.*100ms/);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  const progress = await readFile(
    path.join(session.evidence, "progress.jsonl"),
    "utf8",
  );
  const firstFailures = progress
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "first-failure");
  expect(firstFailures).toEqual([
    expect.objectContaining({
      stage: "stalled-interaction",
      processes: expect.arrayContaining([
        expect.objectContaining({ pid: child.pid }),
      ]),
    }),
  ]);
  await expect(
    session.run("late-interaction", () => app.evaluate(() => 1)),
  ).rejects.toThrow(/closed|cancelled/);

  // A completed presentation response can arrive after cancellation. Keep the
  // real app alive briefly during cleanup so transport failure cannot disguise
  // an unguarded behavior mutation. Only this owned diagnostic identity is faulted.
  const cancellation = new AbortController();
  const controlled = await createPetTestSession({
    dock: "empty",
    behavior: { random: 0.1, running: false },
    isolateAppIdentity: true,
    signal: cancellation.signal,
    preferences: {
      version: 3,
      character: "corgi",
      size: 160,
      visibility: "visible",
    },
  });
  const { app: controlledApp } = await controlled.launch();
  const controlledChild = controlledApp.process();
  const evaluate = controlledApp.evaluate.bind(controlledApp);
  const realClose = controlledApp.close.bind(controlledApp);
  const responseHeld = deferred<void>();
  const releaseResponse = deferred<void>();
  const cleanupEntered = deferred<void>();
  const releaseCleanup = deferred<void>();
  const preferences = await readFile(
    path.join(controlled.profile, "preferences.json"),
    "utf8",
  );
  const delayedResponse = vi
    .spyOn(controlledApp, "evaluate")
    .mockImplementationOnce(async (...args) => {
      const response = await evaluate(...args);
      responseHeld.resolve();
      await releaseResponse.promise;
      return response;
    });
  const delayedClose = vi
    .spyOn(controlledApp, "close")
    .mockImplementation(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      return realClose();
    });
  // Every continuation re-enters the owner, including after a late response.
  const advancing = advanceRest(controlledApp, 0.1, controlled.run).then(
    () => ({ status: "resolved" as const }),
    (error: unknown) => ({ status: "rejected" as const, error: String(error) }),
  );
  const observations: { posture: string; at: number }[] = [];
  try {
    await responseHeld.promise;
    cancellation.abort(
      new Error("cancel while behavior presentation is withheld"),
    );
    await cleanupEntered.promise;
    expect(controlledChild.exitCode).toBe(null);
    releaseResponse.resolve();
    const until = performance.now() + 500;
    do {
      // Independent public observation while the cancelled scenario is held.
      const presentation = await evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Mosey")!
          .webContents.executeJavaScript("window.mosey.getPresentation()"),
      );
      observations.push({
        posture: presentation.posture,
        at: performance.now(),
      });
      expect(presentation.posture).toBe("resting");
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (performance.now() < until);
    expect(
      await readFile(path.join(controlled.profile, "preferences.json"), "utf8"),
    ).toBe(preferences);
  } finally {
    releaseResponse.resolve();
    releaseCleanup.resolve();
    delayedResponse.mockRestore();
    delayedClose.mockRestore();
    await controlled.close();
    await writeFile(
      path.join(controlled.evidence, "cancelled-behavior.json"),
      JSON.stringify({ observations, outcome: await advancing }, null, 2),
    );
  }
  expect((await advancing).status).toBe("rejected");
  expect(
    controlledChild.exitCode !== null || controlledChild.signalCode !== null,
  ).toBe(true);
  await expect(controlled.launch()).rejects.toThrow(/closed|cancelled/);
  await expect(
    controlled.writeProfileFile("preferences.json", "late intent"),
  ).rejects.toThrow(/closed|cancelled/);
  await expect(
    readFile(path.join(controlled.profile, "preferences.json"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("a stalled second quit cancels later preference writes and launches", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    isolateAppIdentity: true,
    preferences: {
      version: 3,
      character: "corgi",
      visibility: "hidden",
      size: 160,
    },
  });
  await session.launch();
  await session.quit();
  const { app } = await session.launch();
  const child = app.process();
  const before = await readFile(
    path.join(session.profile, "preferences.json"),
    "utf8",
  );
  // A transport that never acknowledges the real product action reproduces
  // the old second-close stall without mutating any application clock.
  const stalled = vi
    .spyOn(app, "evaluate")
    .mockImplementation(() => new Promise(() => {}));
  const continuation = (async () => {
    await session.quit();
    await session.writeProfileFile(
      "preferences.json",
      "should never be written",
    );
    await session.launch();
  })();
  await expect(continuation).rejects.toThrow(/normal-exit.*10000ms/);
  stalled.mockRestore();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  await expect(session.launch()).rejects.toThrow(/closed|cancelled/);
  await expect(
    session.writeProfileFile("preferences.json", "late write"),
  ).rejects.toThrow(/closed|cancelled/);
  // The complete profile is released, so the cancelled path cannot leave its
  // failed intent for a following independent scenario to consume.
  await expect(
    readFile(path.join(session.profile, "preferences.json"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(before).visibility).toBe("hidden");
  await session.close();
});
