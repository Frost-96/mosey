import { startForge } from "./support/forge";
import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PNG } from "pngjs";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
// Keep the 1x reload regression reproducible on Retina development machines.
const scaleArgument = `--force-device-scale-factor=${process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"}`;
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
      [`--user-data-dir=${path.join(relocated, "profile")}`],
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
  const profile = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "mosey-app-profile-")),
  );
  let app: ElectronApplication | undefined;
  let stopForge: (() => Promise<void>) | undefined;
  const errors: string[] = [];
  let packagedRoot: string | undefined;
  const ownedNativeChildren = new Set<number>();
  try {
    if (!packaged) stopForge = await startForge();
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
            args: [scaleArgument, `--user-data-dir=${profile}`],
            executablePath: path.join(
              packagedRoot!,
              "Mosey.app/Contents/MacOS/Mosey",
            ),
          }
        : {
            args: [".", scaleArgument, `--user-data-dir=${profile}`],
            timeout: 20000,
          },
    );
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(
      profile,
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
    // External display-scale stimulus against the real renderer. CDP emulates
    // DPR only; this is not evidence of changing physical display hardware.
    const changedRatio =
      Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1") === 2 ? 1 : 2;
    const displaySession = await window.context().newCDPSession(window);
    await displaySession.send("Emulation.setDeviceMetricsOverride", {
      width: 240,
      height: 240,
      deviceScaleFactor: changedRatio,
      mobile: false,
    });
    await expect
      .poll(() =>
        window.evaluate(() => ({
          ratio: devicePixelRatio,
          width: document.querySelector("canvas")!.width,
          height: document.querySelector("canvas")!.height,
        })),
      )
      .toEqual({
        ratio: changedRatio,
        width: 240 * changedRatio,
        height: 240 * changedRatio,
      });
    expect(await opaquePixelCount()).toBeGreaterThan(
      changedRatio === 2 ? 20000 : 5000,
    );
    await displaySession.send("Emulation.clearDeviceMetricsOverride");
    await expect
      .poll(() =>
        window.evaluate(() => document.querySelector("canvas")!.width),
      )
      .toBe(240 * Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"));
    await displaySession.detach();
    // A second launch must exit without adding a pet or terminating the first.
    const duplicate = spawn(
      app.process().spawnfile,
      [...(packaged ? [] : ["."]), `--user-data-dir=${profile}`],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        stdio: "ignore",
      },
    );
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
        // Earlier silhouette assertions read the original canvas. Observe each
        // replacement through the same readback path: at 1x, differing readback
        // histories round interpolated edge alpha differently after reload.
        // Keep exact image equality; do not hide a changed pose with tolerance.
        canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height);
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
    // Public whole-application seam: directed pointer input, rendered pixels,
    // and the actual desktop window bounds (not behavior context).
    // Playwright directs events without moving the physical OS cursor. Keep
    // ordinary drag paths away from that cursor, so its real buttons=0 events
    // do not cancel a synthetic held pointer when the window moves beneath it.
    const placeAwayFromPhysicalCursor = () =>
      app!.evaluate(({ BrowserWindow, screen }) => {
        const pet = BrowserWindow.getAllWindows()[0]!;
        const area = screen.getPrimaryDisplay().workArea;
        const bounds = pet.getBounds();
        const pointer = screen.getCursorScreenPoint();
        const x =
          pointer.x >= area.x + area.width / 2
            ? area.x
            : area.x + area.width - bounds.width;
        pet.setPosition(x, bounds.y, false);
      });
    await placeAwayFromPhysicalCursor();
    const petBounds = () =>
      app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBounds(),
      );
    const ground = await petBounds();
    await window.mouse.move(120, 180);
    await window.mouse.down();
    await window.mouse.move(180, 80, { steps: 5 });
    await expect
      .poll(async () => (await petBounds()).y)
      .toBeLessThan(ground.y - 50);
    await window.mouse.up();
    await expect
      .poll(async () => (await petBounds()).y, { timeout: 4000 })
      .toBe(ground.y);
    await expect
      .poll(async () => idleFrames.has(await pixels()), { timeout: 2000 })
      .toBe(true);
    // Landing ends with idle pixels before its final completion. Establish
    // sustained visible idle, then observe the click response before grabbing.
    for (let sample = 0; sample < 3; sample++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(idleFrames.has(await pixels())).toBe(true);
    }
    // Hold longer than the interrupted click response: its eventual completion
    // must not release or move the held pet.
    await window.mouse.click(120, 180);
    await expect
      .poll(async () => idleFrames.has(await pixels()), {
        timeout: 1500,
        interval: 20,
      })
      .toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await window.mouse.move(120, 180);
    await window.mouse.down();
    await window.mouse.move(120, -100, { steps: 6 });
    await expect
      .poll(async () => (await petBounds()).y)
      .toBeLessThan(ground.y - 200);
    const held = await petBounds();
    expect(idleFrames.has(await pixels())).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(await petBounds()).toEqual(held);
    await window.screenshot({
      path: `test-results/${packaged ? "packaged" : "development"}-held.png`,
      omitBackground: true,
    });
    await window.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(await petBounds()).toEqual(held);
    expect(idleFrames.has(await pixels())).toBe(false);
    await window.screenshot({
      path: `test-results/${packaged ? "packaged" : "development"}-flutter.png`,
      omitBackground: true,
    });
    await expect
      .poll(async () => (await petBounds()).y, { interval: 10 })
      .toBeGreaterThan(held.y + 20);
    await expect.poll(async () => (await petBounds()).y).toBe(ground.y);
    await window.screenshot({
      path: `test-results/${packaged ? "packaged" : "development"}-landing.png`,
      omitBackground: true,
    });
    await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
    for (const phase of ["immediate", "flutter", "falling", "landing"]) {
      await window.mouse.move(120, 180);
      await window.mouse.down();
      await window.mouse.move(120, -120, { steps: 5 });
      await expect
        .poll(async () => (await petBounds()).y)
        .toBeLessThan(ground.y - 200);
      const elevated = await petBounds();
      await window.mouse.up();
      if (phase === "flutter")
        await new Promise((resolve) => setTimeout(resolve, 100));
      else if (phase === "falling")
        await expect
          .poll(async () => (await petBounds()).y, { interval: 10 })
          .toBeGreaterThan(elevated.y + 20);
      else if (phase === "landing")
        await expect
          .poll(async () => (await petBounds()).y, { interval: 10 })
          .toBe(ground.y);
      // Use the visible body as the input target even when the pose changes.
      const point = await window.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        const ratio = devicePixelRatio;
        let best = Infinity,
          x = 120,
          y = 180;
        for (let py = 0; py < canvas.height; py++)
          for (let px = 0; px < canvas.width; px++) {
            const distance = (px / ratio - 120) ** 2 + (py / ratio - 180) ** 2;
            if (
              pixels[(py * canvas.width + px) * 4 + 3] > 127 &&
              distance < best
            ) {
              best = distance;
              x = px / ratio;
              y = py / ratio;
            }
          }
        return { x, y };
      });
      await window.mouse.move(point.x, point.y);
      await window.mouse.down();
      await new Promise((resolve) => setTimeout(resolve, 70));
      const recaptured = await petBounds();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(await petBounds(), `regrab during ${phase} stays held`).toEqual(
        recaptured,
      );
      expect(
        idleFrames.has(await pixels()),
        `regrab during ${phase} draws held pose`,
      ).toBe(false);
      await window.mouse.up();
      await expect
        .poll(async () => (await petBounds()).y, { timeout: 3000 })
        .toBe(ground.y);
      await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
    }
    // Browser pointer-capture loss is a real input cancellation event; subsequent
    // directed mouse movement must not keep moving the pet or trigger a click.
    await window.mouse.move(120, 180);
    await window.mouse.down();
    await window.mouse.move(120, -120, { steps: 5 });
    await expect
      .poll(async () => (await petBounds()).y)
      .toBeLessThan(ground.y - 200);
    await window.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      // Mouse pointer ID is specified by the browser, observed via pointer events.
      canvas.addEventListener(
        "pointermove",
        (event) => {
          if (canvas.hasPointerCapture(event.pointerId))
            canvas.releasePointerCapture(event.pointerId);
        },
        { once: true },
      );
    });
    await window.mouse.move(121, -120);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await window.mouse.move(500, -300);
    await expect.poll(async () => (await petBounds()).y).toBe(ground.y);
    await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
    const cancelled = await petBounds();
    await window.mouse.move(-500, -500);
    await window.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await petBounds()).toEqual(cancelled);
    expect(idleFrames.has(await pixels())).toBe(true);
    // Hiding during capture cancels immediately; old pointerup cannot restart it.
    await window.mouse.move(120, 180);
    await window.mouse.down();
    await window.mouse.move(120, 0, { steps: 4 });
    await expect
      .poll(async () => (await petBounds()).y)
      .toBeLessThan(ground.y - 100);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.hide(),
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.showInactive(),
    );
    await window.mouse.up();
    await expect.poll(async () => (await petBounds()).y).toBe(ground.y);
    await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
    // The visible desktop window stays within the primary work area even when
    // captured input travels far beyond it, then releases at the same floor.
    const area = await app.evaluate(
      ({ screen }) => screen.getPrimaryDisplay().workArea,
    );
    await window.mouse.move(120, 180);
    await window.mouse.down();
    await window.mouse.move(10000, -10000);
    await expect
      .poll(async () => (await petBounds()).x)
      .toBe(area.x + area.width - ground.width);
    expect((await petBounds()).y).toBe(area.y);
    await window.mouse.up();
    await expect
      .poll(async () => (await petBounds()).y, { timeout: 4000 })
      .toBe(ground.y);
    await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
    if (!packaged) {
      await placeAwayFromPhysicalCursor();
      await window.mouse.move(120, 180);
      await window.mouse.down();
      await window.mouse.move(120, 0, { steps: 4 });
      await expect
        .poll(async () => (await petBounds()).y)
        .toBeLessThan(ground.y - 100);
      await window.evaluate(() => location.reload());
      await expect.poll(async () => (await petBounds()).y).toBe(ground.y);
      await expect
        .poll(async () => idleFrames.has(await pixels()), { timeout: 5000 })
        .toBe(true);
      const reloaded = await petBounds();
      await window.mouse.move(500, -500);
      await window.mouse.up();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await petBounds()).toEqual(reloaded);
      expect(idleFrames.has(await pixels())).toBe(true);
    }
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
    await stopForge?.();
    if (packagedRoot) await rm(packagedRoot, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});
