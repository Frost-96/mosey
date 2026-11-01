import type { ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { createLoginTestSession } from "./support/login-session";

const probe = vi.hoisted(() => ({
  pause: false,
  corrupt: false,
  stopped: false,
  bundle: undefined as string | undefined,
  child: undefined as ChildProcess | undefined,
  resume: undefined as ReturnType<typeof setTimeout> | undefined,
}));

// Interpose at the native command boundary, preserving real codesign bytes,
// exit status, AbortSignal and process lifetime. No successful result is faked.
vi.mock("node:child_process", async (original) => {
  const native = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const { appendFileSync } = await import("node:fs");
  const command = promisify(native.execFile);
  const execFile = (...args: Parameters<typeof native.execFile>) =>
    native.execFile(...args);
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: Parameters<typeof command>) => {
      const argv = args[1];
      const bundle = Array.isArray(argv) ? argv.at(-1) : undefined;
      const ownedVerification =
        args[0] === "/usr/bin/codesign" &&
        Array.isArray(argv) &&
        argv.includes("--verify") &&
        bundle?.includes("mosey-pet-session-");
      if (ownedVerification) {
        probe.bundle = bundle;
        if (probe.corrupt)
          appendFileSync(path.join(bundle!, "Contents/Info.plist"), "\n");
      }
      const result = command(...args);
      if (ownedVerification && probe.pause) {
        probe.child = result.child;
        probe.stopped = result.child.kill("SIGSTOP");
        probe.resume = setTimeout(() => result.child.kill("SIGCONT"), 6000);
      }
      return result;
    },
  });
  return { ...native, execFile };
});

function resetProbe() {
  probe.pause = false;
  probe.corrupt = false;
  probe.stopped = false;
  probe.bundle = undefined;
  probe.child = undefined;
  onTestFinished(async () => {
    clearTimeout(probe.resume);
    probe.child?.kill("SIGCONT");
    if (probe.child)
      await expect
        .poll(
          () =>
            probe.child!.exitCode !== null || probe.child!.signalCode !== null,
        )
        .toBe(true);
    probe.pause = false;
    probe.corrupt = false;
  });
}

test("login preparation accepts a valid signature after a slow native verification", async () => {
  resetProbe();
  probe.pause = true;
  const session = await createLoginTestSession();
  expect(probe.stopped).toBe(true);
  expect(probe.child?.exitCode).toBe(0);
  const events = await readFile(
    path.join(session.evidence, "login-items.jsonl"),
    "utf8",
  );
  expect(events).toContain('"event":"signature-verified"');
  await session.close();
  await expect(access(session.bundle)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("login preparation rejects a damaged signed bundle before registration", async () => {
  resetProbe();
  probe.corrupt = true;
  await expect(createLoginTestSession()).rejects.toThrow(/invalid|modified/i);
  expect(probe.bundle).toBeDefined();
  await expect(access(probe.bundle!)).rejects.toMatchObject({ code: "ENOENT" });
});

test("cancelling native login verification stops its process and releases the owned bundle", async () => {
  resetProbe();
  probe.pause = true;
  const controller = new AbortController();
  const preparing = createLoginTestSession({ signal: controller.signal });
  const failure = preparing.catch((error: unknown) => error);
  await expect.poll(() => probe.stopped, { timeout: 10000 }).toBe(true);
  controller.abort(new Error("cancel native login verification"));
  // A stopped OS process must run to consume its pending termination signal.
  probe.child!.kill("SIGCONT");
  expect(await failure).toMatchObject({
    message: expect.stringMatching(/cancel/i),
  });
  await expect
    .poll(
      () => probe.child!.exitCode !== null || probe.child!.signalCode !== null,
    )
    .toBe(true);
  await expect(access(probe.bundle!)).rejects.toMatchObject({ code: "ENOENT" });
});
