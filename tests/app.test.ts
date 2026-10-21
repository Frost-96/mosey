import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PNG } from "pngjs";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test.runIf(packaged)(
  "packaged app starts a renderer without an inspector bootstrap",
  async () => {
    const relocated = await mkdtemp(path.join(os.tmpdir(), "mosey-relocated-"));
    const bundle = path.join(relocated, "Mosey.app");
    execFileSync("/usr/bin/ditto", [
      path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
      bundle,
    ]);
    const child = spawn(
      process.env.MOSEY_STARTUP_EXECUTABLE ??
        path.join(bundle, "Contents/MacOS/Mosey"),
      [],
      {
        env: {
          HOME: os.homedir(),
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TMPDIR: os.tmpdir(),
        },
        cwd: "/",
        stdio: "pipe",
      },
    );
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const descendants = () =>
      execFileSync("/bin/ps", ["-axo", "pid=,ppid=,args="], {
        encoding: "utf8",
      })
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
        .filter((match) => match && Number(match[2]) === child.pid);
    try {
      await expect
        .poll(
          () => {
            if (child.exitCode !== null)
              throw new Error(`App exited before renderer startup: ${output}`);
            return descendants().some((match) =>
              match![3].includes("--type=renderer"),
            );
          },
          { timeout: 8000 },
        )
        .toBe(true);
      expect(output).not.toMatch(/Uncaught Exception|Error launching app/);
    } finally {
      child.kill("SIGTERM");
      await expect
        .poll(() => child.exitCode !== null || child.signalCode !== null, {
          timeout: 3000,
        })
        .toBe(true);
      await rm(relocated, { recursive: true, force: true });
    }
  },
);

test("a real app displays one animated corgi and quits from its menu", async () => {
  let app: ElectronApplication | undefined;
  let server: ChildProcess | undefined;
  const errors: string[] = [];
  let shim: string | undefined;
  let packagedRoot: string | undefined;
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
    if (packaged) {
      packagedRoot = await mkdtemp(path.join(os.tmpdir(), "mosey-packaged-"));
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(packagedRoot, "Mosey.app"),
      ]);
    }
    app = await electron.launch(
      packaged
        ? {
            timeout: 20000,
            executablePath: path.join(
              packagedRoot!,
              "Mosey.app/Contents/MacOS/Mosey",
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
    const opaquePixelCount = () =>
      window.evaluate(() => {
        const canvas = document.querySelector("canvas");
        if (!canvas) return 0;
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        return Array.from(pixels).filter(
          (value, i) => i % 4 === 3 && value > 127,
        ).length;
      });
    await expect
      .poll(opaquePixelCount, { timeout: 10000 })
      .toBeGreaterThan(5000);
    if (!packaged) {
      // Renderer-originated navigation exercises will-navigate; page.reload()
      // uses a browser API that can bypass the application's navigation guard.
      await window.evaluate(() => {
        document.documentElement.dataset.reloadIdentity = "original-document";
        location.reload();
      });
      await expect
        .poll(
          () =>
            window.evaluate(
              () => document.documentElement.dataset.reloadIdentity ?? null,
            ),
          { timeout: 10000 },
        )
        .toBe(null);
      await expect
        .poll(opaquePixelCount, { timeout: 10000 })
        .toBeGreaterThan(5000);
    }
    // Renderer-originated navigation to another path must be stopped by the
    // navigation guard itself, including packaged navigation back to its own URL.
    const originalURL = window.url();
    const deniedURLs = [new URL("unexpected-navigation", originalURL).href];
    if (packaged) deniedURLs.push(originalURL);
    for (const destination of deniedURLs) {
      await window.evaluate(() => {
        document.documentElement.dataset.navigationIdentity = "same-document";
      });
      const prevented = await app.evaluate(
        async ({ BrowserWindow }, destination) => {
          const contents = BrowserWindow.getAllWindows()[0]!.webContents;
          return new Promise<boolean>((resolve, reject) => {
            const listener = (event: Electron.Event, url: string) => {
              if (url !== destination) return;
              clearTimeout(timer);
              contents.off("will-navigate", listener);
              resolve(event.defaultPrevented);
            };
            const timer = setTimeout(() => {
              contents.off("will-navigate", listener);
              reject(
                new Error("Renderer navigation did not reach will-navigate"),
              );
            }, 5000);
            contents.on("will-navigate", listener);
            void contents
              .executeJavaScript(
                `location.href = ${JSON.stringify(destination)}`,
              )
              .catch((error: unknown) => {
                clearTimeout(timer);
                contents.off("will-navigate", listener);
                reject(error);
              });
          });
        },
        destination,
      );
      expect(prevented).toBe(true);
      expect(window.url()).toBe(originalURL);
      expect(
        await window.evaluate(
          () => document.documentElement.dataset.navigationIdentity,
        ),
      ).toBe("same-document");
      expect(await opaquePixelCount()).toBeGreaterThan(5000);
    }
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
    // Whole-app targeted-input evidence only: this does not prove OS routing.
    const pixels = () =>
      window.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        return canvas.toDataURL();
      });
    const idleFrames = new Set<string>();
    const until = Date.now() + 2200;
    while (Date.now() < until) {
      idleFrames.add(await pixels());
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await window.mouse.click(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(idleFrames.has(await pixels())).toBe(true);
    const responses = new Set<string>();
    for (const random of [0.01, 0.4, 0.9]) {
      await app.evaluate((_electron, value) => {
        Math.random = () => value;
      }, random);
      await window.mouse.click(120, 180);
      await expect
        .poll(async () => idleFrames.has(await pixels()), {
          timeout: 1500,
          interval: 30,
        })
        .toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 600));
      responses.add(await pixels());
      await window.screenshot({
        path: `test-results/${packaged ? "packaged" : "development"}-response-${random}.png`,
        omitBackground: true,
      });
      // A burst during a response must not leave queued actions playing later.
      for (let click = 0; click < 5; click++)
        await window.mouse.click(120, 180);
      await expect
        .poll(async () => idleFrames.has(await pixels()), {
          timeout: 5000,
          interval: 50,
        })
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(idleFrames.has(await pixels())).toBe(true);
    }
    expect(responses.size).toBe(3);
    // A system visibility change cancels the reaction; showing resumes interaction.
    await window.mouse.click(120, 180);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.hide(),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.showInactive(),
    );
    await expect
      .poll(async () => idleFrames.has(await pixels()), { timeout: 2000 })
      .toBe(true);
    await window.mouse.click(120, 180);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(idleFrames.has(await pixels())).toBe(false);
    await expect
      .poll(async () => idleFrames.has(await pixels()), { timeout: 2500 })
      .toBe(true);
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
    if (packagedRoot) await rm(packagedRoot, { recursive: true, force: true });
  }
});
