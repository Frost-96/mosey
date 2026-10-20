import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PNG } from "pngjs";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("a real app displays one animated corgi and quits from its menu", async () => {
  let app: ElectronApplication | undefined;
  let server: ChildProcess | undefined;
  const errors: string[] = [];
  let shim: string | undefined;
  const ownedNativeChildren = new Set<number>();
  try {
    if (!packaged) {
      shim = await mkdtemp(path.join(os.tmpdir(), "mosey-forge-"));
      const executable = path.join(
        shim,
        "Electron.app/Contents/MacOS/Electron",
      );
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(
        executable,
        "#!/bin/sh\necho MOSEY_TEST_READY\nexec /bin/cat\n",
      );
      await chmod(executable, 0o755);
      server = spawn("pnpm", ["start"], {
        env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: shim },
        stdio: "pipe",
        detached: true,
      });
      let output = "";
      server.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      server.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      await expect
        .poll(
          () => {
            if (server?.exitCode !== null) throw new Error(output);
            return output;
          },
          { timeout: 60000 },
        )
        .toContain("MOSEY_TEST_READY");
    }
    app = await electron.launch(
      packaged
        ? {
            timeout: 20000,
            executablePath: path.resolve(
              "out/Mosey-darwin-arm64/Mosey.app/Contents/MacOS/Mosey",
            ),
          }
        : { args: ["."], timeout: 20000 },
    );
    const window = await app.firstWindow({ timeout: 15000 });
    window.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error.message);
    });
    window.on("console", (message) =>
      console.log(message.type(), message.text()),
    );
    expect(app.windows()).toHaveLength(1);
    await expect
      .poll(
        async () =>
          window.evaluate(() => {
            const canvas = document.querySelector("canvas");
            if (!canvas) return 0;
            const pixels = canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height).data;
            return Array.from(pixels).filter(
              (value, i) => i % 4 === 3 && value > 127,
            ).length;
          }),
        { timeout: 10000 },
      )
      .toBeGreaterThan(5000);
    // A second launch must exit without adding a pet or terminating the first.
    const duplicate = spawn(app.process().spawnfile, packaged ? [] : ["."], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: "ignore",
    });
    try {
      await expect.poll(() => duplicate.exitCode, { timeout: 10000 }).toBe(0);
      expect(app.windows()).toHaveLength(1);
      expect(await window.evaluate(() => document.body.innerText)).toBe("");
    } finally {
      if (duplicate.exitCode === null) duplicate.kill();
    }
    expect(
      await window.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const data = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let bottom = -1;
        for (let y = 0; y < canvas.height; y++)
          for (let x = 0; x < canvas.width; x++)
            if (data[(y * canvas.width + x) * 4 + 3] > 127) bottom = y;
        return Math.round((bottom + 1) / globalThis.devicePixelRatio);
      }),
    ).toBe(240);
    const capture = async () =>
      PNG.sync.read(await window.screenshot({ omitBackground: true }));
    const first = await capture();
    expect(first.data.some((value, i) => i % 4 === 3 && value > 127)).toBe(
      true,
    );
    await expect
      .poll(async () => (await capture()).data.equals(first.data), {
        timeout: 5000,
        interval: 75,
      })
      .toBe(false);
    expect(
      await window.evaluate(() => typeof Reflect.get(window, "require")),
    ).toBe("undefined");
    const preload = await app.evaluate(({ app }) =>
      process
        .getBuiltinModule("node:fs")
        .readFileSync(app.getAppPath() + "/.vite/build/preload.cjs", "utf8"),
    );
    expect(preload).not.toMatch(/^import |^export /m);
    const runtime = await app.evaluate(() => ({
      node: process.versions.node,
      electron: process.versions.electron,
    }));
    expect(runtime).toEqual({ node: "24.22.0", electron: "44.9.1" });
    expect(errors).toEqual([]);
    // Public menu -> passive status -> local evidence -> owned OS process lifecycle.
    const invokeDiagnostic = async (label: string) =>
      app!.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((entry) => entry.label === "Dock validation")
          ?.submenu?.items.find((entry) => entry.label === label);
        if (!item || !item.enabled)
          throw new Error(`Diagnostic menu item unavailable: ${label}`);
        item.click();
      }, label);
    const diagnosticWindow = app.waitForEvent("window").catch(() => undefined);
    await invokeDiagnostic("Start Dock validation (120 seconds)");
    const diagnostic = await diagnosticWindow;
    if (!diagnostic) throw new Error("Diagnostic window did not open");
    await diagnostic
      .getByRole("heading", { name: "Dock validation" })
      .waitFor();
    const { readFile, stat } = await import("node:fs/promises");
    const runs: {
      localLog: string;
      nativePID: number;
      capturing: boolean;
      faultInjection: string;
    }[] = [];
    const inspectRun = async () => {
      await expect
        .poll(() => diagnostic.locator("body").innerText(), { timeout: 15000 })
        .toMatch(
          /Capturing diagnostic statistics|Blocked: native screen-recording permission unavailable/,
        );
      const body = await diagnostic.locator("body").innerText();
      expect(body).not.toContain("Failed:");
      const localLog = await diagnostic.getByLabel("Local log").inputValue();
      expect(path.isAbsolute(localLog)).toBe(true);
      const contents = await readFile(localLog, "utf8");
      expect((await stat(localLog)).size).toBeLessThanOrEqual(8 * 1024 * 1024);
      const records = contents
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(records[0].type).toBe("electron-host");
      const native = records
        .filter((record) => record.type === "native")
        .map((record) => record.record);
      const environment = native.find(
        (record) => record.type === "environment",
      );
      expect(environment.appStatus).toBe(false);
      const capturing = body.includes("Capturing diagnostic statistics");
      if (!capturing) {
        expect(
          native.some(
            (record) =>
              record.type === "unavailable" &&
              record.status === "permission_unavailable" &&
              record.shareableContentQueryAttempted === false,
          ),
        ).toBe(true);
        expect(
          native.some((record) => record.type === "stream_configuration"),
        ).toBe(false);
      } else
        expect(
          native.some((record) => record.type === "stream_configuration"),
        ).toBe(true);
      const result = {
        localLog,
        nativePID: environment.processID as number,
        capturing,
        faultInjection: capturing
          ? "SIGSTOP owned helper"
          : "Skipped live fault: explicit native preflight blocked",
      };
      if (capturing) ownedNativeChildren.add(result.nativePID);
      runs.push(result);
      return result;
    };
    const waitGone = async (pid: number) => {
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 6000 },
        )
        .toBe(true);
      ownedNativeChildren.delete(pid);
    };
    const firstRun = await inspectRun();
    if (firstRun.capturing) {
      await expect
        .poll(async () =>
          (await readFile(firstRun.localLog, "utf8")).includes(
            '"type":"heartbeat"',
          ),
        )
        .toBe(true);
      process.kill(firstRun.nativePID, "SIGSTOP");
      await expect
        .poll(() => diagnostic.locator("body").innerText(), { timeout: 6000 })
        .toContain("Failed: native output heartbeat unavailable");
      await expect
        .poll(() => diagnostic.locator("body").innerText())
        .toContain("Latest validated native currentness: Unavailable");
      await waitGone(firstRun.nativePID);
    }
    await invokeDiagnostic("Stop Dock validation");
    await expect
      .poll(() => diagnostic.locator("body").innerText())
      .toContain("Stopped");
    await waitGone(firstRun.nativePID);
    await invokeDiagnostic("Start Dock validation (120 seconds)");
    const secondRun = await inspectRun();
    expect(secondRun.localLog).not.toBe(firstRun.localLog);
    if (secondRun.capturing) process.kill(secondRun.nativePID, "SIGSTOP");
    await invokeDiagnostic("Stop Dock validation");
    await expect
      .poll(() => diagnostic.locator("body").innerText(), { timeout: 6000 })
      .toContain("Stopped");
    await waitGone(secondRun.nativePID);
    await invokeDiagnostic("Start Dock validation (120 seconds)");
    const quitRun = await inspectRun();
    expect(quitRun.localLog).not.toBe(secondRun.localLog);
    if (quitRun.capturing) process.kill(quitRun.nativePID, "SIGSTOP");
    await mkdir("test-results", { recursive: true });
    await window.screenshot({
      path: `test-results/${packaged ? "packaged" : "development"}-corgi.png`,
      omitBackground: true,
    });
    const child = app.process();
    const closed = new Promise<void>((resolve) =>
      app!.once("close", () => resolve()),
    );
    await app.evaluate(({ Menu }) => {
      const quit = Menu.getApplicationMenu()
        ?.items.find((item) => item.label === "Mosey")
        ?.submenu?.items.find((item) => item.label === "Quit Mosey");
      if (!quit) throw new Error("Quit Mosey menu item is absent");
      quit.click();
    });
    await closed;
    await expect.poll(() => child.exitCode).toBe(0);
    await waitGone(quitRun.nativePID);
    for (const [index, run] of runs.entries())
      await writeFile(
        `test-results/${packaged ? "packaged" : "development"}-dock-run-${index + 1}.jsonl`,
        await readFile(run.localLog),
      );
    await writeFile(
      `test-results/${packaged ? "packaged" : "development"}-dock-lifecycle.json`,
      JSON.stringify(runs, null, 2),
    );
    await writeFile(
      `test-results/${packaged ? "packaged" : "development"}-runtime.json`,
      JSON.stringify(runtime, null, 2),
    );
  } catch (error) {
    await mkdir("test-results", { recursive: true });
    for (const [i, window] of (app?.windows() ?? []).entries())
      await window
        .screenshot({
          path: `test-results/failure-${packaged ? "packaged" : "development"}-${i}.png`,
        })
        .catch(() => {});
    throw error;
  } finally {
    for (const pid of ownedNativeChildren) {
      try {
        process.kill(pid, "SIGCONT");
      } catch {
        /* exited */
      }
    }
    await app?.close().catch(() => {});
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
      await new Promise<void>((resolve) => {
        if (server!.exitCode !== null || server!.signalCode !== null)
          return resolve();
        server!.once("exit", () => resolve());
      });
    }
    if (shim) await rm(shim, { recursive: true, force: true });
  }
});
