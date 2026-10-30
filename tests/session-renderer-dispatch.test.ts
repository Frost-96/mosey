import { expect, test } from "vitest";
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { invokePetMenu } from "./support/pet-menu";

test("driver visibility input preserves renderer recovery while a real interval is awaiting dispatch", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    // A failed ordering deliberately exposes a fatal main-process exception.
    // Keep its native crash history outside ordinary scenario identities.
    isolateAppIdentity: true,
  });
  const { app, renderer } = await session.launch();
  const child = app.process();
  await session.run("first-renderer-crash", () => renderer.crash());
  await session.run(
    "first-renderer-recovery",
    () => renderer.waitUntilReady(),
    {
      timeout: 10000,
    },
  );
  const identity = await session.run("crash-inspector-identity", () =>
    app.evaluate(() => ({
      url: process.getBuiltinModule("node:inspector").url(),
      versions: process.versions,
    })),
  );
  if (!identity.url) throw new Error("Application Inspector is not available");
  await session.run("retain-crash-runtime", () =>
    writeFile(
      path.join(session.evidence, "crash-runtime.json"),
      JSON.stringify(identity.versions, null, 2),
    ),
  );
  const socket = new WebSocket(identity.url);
  const connected = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Crash Inspector connection failed")),
      { once: true },
    );
  });
  const requests = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  let nextRequest = 0;
  let didPause!: () => void;
  const paused = new Promise<void>((resolve) => {
    didPause = resolve;
  });
  socket.addEventListener("message", (event) => {
    const message: {
      id?: number;
      error?: { message: string };
      method?: string;
    } = JSON.parse(String(event.data));
    if (message.method === "Debugger.paused") didPause();
    if (message.id === undefined) return;
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve();
  });
  socket.addEventListener("close", () => {
    for (const request of requests.values())
      request.reject(new Error("Crash Inspector disconnected"));
    requests.clear();
  });
  const send = (method: string, params: object = {}) =>
    new Promise<void>((resolve, reject) => {
      const id = ++nextRequest;
      requests.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const journal = path.join(session.evidence, "crash-dispatch.jsonl");
  const record = (event: string, detail?: unknown) =>
    appendFileSync(
      journal,
      JSON.stringify({ event, at: Date.now(), detail }) + "\n",
    );
  let hiding: Promise<{ passed: true } | { error: unknown }> | undefined;
  let crashing: Promise<{ passed: true } | { error: unknown }> | undefined;
  try {
    await session.run("crash-inspector-connect", () => connected);
    await session.run("crash-inspector-enable", () => send("Debugger.enable"));
    await session.run("crash-inspector-pauses", () =>
      send("Debugger.setSkipAllPauses", { skip: false }),
    );
    await session.run("arm-crash-interval-dispatch", () =>
      app.evaluate(({ BrowserWindow }, output) => {
        const pet = BrowserWindow.getAllWindows().find(
          (window) => window.getTitle() === "Mosey",
        )!;
        const contents = pet.webContents;
        const { createHook, executionAsyncResource } =
          process.getBuiltinModule("node:async_hooks");
        const { appendFileSync } = process.getBuiltinModule("node:fs");
        const record = (event: string, detail?: unknown) =>
          appendFileSync(
            output,
            JSON.stringify({ event, at: Date.now(), detail }) + "\n",
          );
        process.once("uncaughtExceptionMonitor", (error, origin) =>
          record("main-exception", { origin, stack: error.stack }),
        );
        const rendererPid = contents.getOSProcessId();
        record("renderer-before-crash", { rendererPid });
        const interval = setInterval(() => record("interval-dispatched"), 50);
        contents.once("render-process-gone", (_event, detail) => {
          record("renderer-gone", { rendererPid, ...detail });
        });
        // Packaged macOS may omit the hide event. Observe the public native
        // operation once and delegate it unchanged, then release this fixture's
        // interval. Neither product timers nor their private fields are read.
        const hide = pet.hide;
        pet.hide = function () {
          pet.hide = hide;
          Reflect.apply(hide, this, []);
          record("visibility-hidden", { visible: pet.isVisible() });
          clearInterval(interval);
        };
        let selected = false;
        const hook = createHook({
          init(_id, type) {
            if (selected && type === "Immediate") record("work-queued");
            if (selected && type === "Timeout") record("driver-timer-created");
          },
          before() {
            if (selected || executionAsyncResource() !== interval) return;
            selected = true;
            record("interval-awaiting-dispatch");
            // This deliberate public dispatch boundary exercises the real
            // driver fault without depending on product timers or Node fields.
            // eslint-disable-next-line no-debugger
            debugger;
            hook.disable();
            record("interval-resumed");
          },
        }).enable();
      }, journal),
    );
    await session.run("crash-interval-paused", () => paused);
    record("driver-hide-requested");
    hiding = invokePetMenu(app, "Hide Mosey", session.run).then(
      () => {
        record("driver-hide-resolved");
        return { passed: true as const };
      },
      (error: unknown) => {
        record("driver-hide-rejected", String(error));
        return { error };
      },
    );
    await expect
      .poll(
        async () => {
          const evidence = await session.run("crash-request-observed", () =>
            readFile(journal, "utf8"),
          );
          return (
            evidence.includes('"event":"visibility-hidden"') ||
            evidence.includes('"event":"work-queued"')
          );
        },
        { timeout: 2000 },
      )
      .toBe(true);
    await session.run("resume-crash-interval", () => send("Debugger.resume"));
    socket.close();
    const hidden = await hiding;
    if ("error" in hidden) throw hidden.error;
    record("driver-crash-requested");
    crashing = session
      .run("crash-after-hidden-input", () => renderer.crash())
      .then(
        () => {
          record("driver-crash-resolved");
          return { passed: true as const };
        },
        (error: unknown) => {
          record("driver-crash-rejected", String(error));
          return { error };
        },
      );
    const outcome = await crashing;
    if ("error" in outcome) throw outcome.error;
    const events = (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.event === "interval-dispatched")).toBe(
      true,
    );
    expect(["crashed", "killed"]).toContain(
      events.find((event) => event.event === "renderer-gone")?.detail.reason,
    );
    await expect
      .poll(() =>
        session.run("second-renderer-failed", () =>
          app.evaluate(({ BrowserWindow }) => {
            const pet = BrowserWindow.getAllWindows().find(
              (window) => window.getTitle() === "Mosey",
            )!;
            return !pet.isVisible() && pet.webContents.isCrashed();
          }),
        ),
      )
      .toBe(true);
    await invokePetMenu(app, "Retry Mosey", session.run);
    await invokePetMenu(app, "Show Mosey", session.run);
    const recovered = await session.run(
      "retried-renderer-paint",
      () => renderer.waitUntilReady(),
      { timeout: 10000 },
    );
    expect(recovered.presentation.posture).toBe("resting");
    expect(recovered.opaquePixels).toBeGreaterThan(0);
    await session.quit();
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBe(null);
    const exceptions = await readFile(
      path.join(session.evidence, "main-exceptions.jsonl"),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    expect(exceptions).toBe("");
  } finally {
    socket.close();
    await hiding;
    await crashing;
    await session.close();
  }
});
