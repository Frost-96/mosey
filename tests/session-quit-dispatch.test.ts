import { expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";

test("driver Quit completes while a real interval is awaiting dispatch", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    // A regression intentionally exposes a fatal timer exception. Its recovery
    // history must not affect the next ordinary application identity.
    isolateAppIdentity: true,
  });
  const { app } = await session.launch();
  const identity = await session.run("quit-inspector-identity", () =>
    app.evaluate(() => ({
      url: process.getBuiltinModule("node:inspector").url(),
      versions: process.versions,
    })),
  );
  if (!identity.url) throw new Error("Application Inspector is not available");
  await session.run("retain-quit-runtime", () =>
    writeFile(
      path.join(session.evidence, "quit-runtime.json"),
      JSON.stringify(identity.versions, null, 2),
    ),
  );
  const socket = new WebSocket(identity.url);
  const connected = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Quit Inspector connection failed")),
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
      request.reject(new Error("Quit Inspector disconnected"));
    requests.clear();
  });
  const send = (method: string, params: object = {}) =>
    new Promise<void>((resolve, reject) => {
      const id = ++nextRequest;
      requests.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const journal = path.join(session.evidence, "quit-dispatch.jsonl");
  let quitting: Promise<{ passed: true } | { error: unknown }> | undefined;
  try {
    await session.run("quit-inspector-connect", () => connected);
    await session.run("quit-inspector-enable", () => send("Debugger.enable"));
    await session.run("quit-inspector-pauses", () =>
      send("Debugger.setSkipAllPauses", { skip: false }),
    );
    await session.run("arm-real-interval-dispatch", () =>
      app.evaluate(({ app }, output) => {
        const { createHook, executionAsyncResource } =
          process.getBuiltinModule("node:async_hooks");
        const { appendFileSync } = process.getBuiltinModule("node:fs");
        const record = (event: string) =>
          appendFileSync(
            output,
            JSON.stringify({ event, at: Date.now() }) + "\n",
          );
        // This is our own real interval and the public before-quit event. The
        // regression has no dependency on product timers or Node timer fields.
        const interval = setInterval(() => record("interval-dispatched"), 50);
        app.once("before-quit", () => {
          record("quit-requested");
          clearInterval(interval);
        });
        let selected = false;
        const hook = createHook({
          init(_id, type) {
            if (selected && type === "Immediate") record("work-queued");
          },
          before() {
            if (selected || executionAsyncResource() !== interval) return;
            selected = true;
            record("interval-awaiting-dispatch");
            // Deliberately place the actual driver request at the public async
            // boundary where synchronous Quit used to invalidate the callback.
            // eslint-disable-next-line no-debugger
            debugger;
            hook.disable();
            record("interval-resumed");
          },
        }).enable();
      }, journal),
    );
    await session.run("interval-dispatch-paused", () => paused);
    // Observe rejection immediately; cleanup or a delayed acknowledgement must
    // never turn this concurrent real exit request into an unhandled rejection.
    quitting = session.quit().then(
      () => ({ passed: true }),
      (error: unknown) => ({ error }),
    );
    await expect
      .poll(
        async () => {
          const evidence = await session.run("quit-request-observed", () =>
            readFile(journal, "utf8"),
          );
          return (
            evidence.includes('"event":"quit-requested"') ||
            evidence.includes('"event":"work-queued"')
          );
        },
        { timeout: 2000 },
      )
      .toBe(true);
    await session.run("resume-interval-dispatch", () =>
      send("Debugger.resume"),
    );
    socket.close();
    const outcome = await quitting;
    if ("error" in outcome) throw outcome.error;
    expect(app.process().exitCode).toBe(0);
    expect(app.process().signalCode).toBe(null);
    const exceptions = await session.run("quit-main-exceptions", () =>
      readFile(
        path.join(session.evidence, "main-exceptions.jsonl"),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      }),
    );
    expect(exceptions).toBe("");
  } finally {
    // Disconnecting also releases a pause if an earlier observation failed.
    // The session's independent cleanup still owns the application process.
    socket.close();
    await quitting;
    await session.close();
  }
});
