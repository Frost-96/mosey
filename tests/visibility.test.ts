import { startForge } from "./support/forge";
import { test, expect, onTestFailed } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  readFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendFileSync } from "node:fs";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

test("manual visibility survives restart, duplicate launches and damaged preferences", async () => {
  const started = performance.now();
  const evidence = packaged ? "packaged" : "development";
  const progressFile = `test-results/${evidence}-visibility-progress.jsonl`;
  await mkdir("test-results", { recursive: true });
  await writeFile(progressFile, "");
  const mark = (stage: string) => {
    appendFileSync(
      progressFile,
      JSON.stringify({ stage, elapsed: performance.now() - started }) + "\n",
    );
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-visibility-"));
  const profile = path.join(root, "profile");
  let stopForge: (() => Promise<void>) | undefined;
  let duplicate: ChildProcess | undefined;
  let app: ElectronApplication | undefined;
  let applicationProcess: ChildProcess | undefined;
  let launches = 0;
  onTestFailed(async () => {
    mark("test-failed");
    const child = applicationProcess;
    if (child?.exitCode === null && child.signalCode === null) {
      // A Vitest deadline does not unwind a pending Playwright call. Preserve
      // the native stack before releasing only this test's application process.
      try {
        execFileSync(
          "/usr/bin/sample",
          [
            String(child.pid),
            "1",
            "1",
            "-file",
            path.resolve(`test-results/${evidence}-visibility-process.txt`),
          ],
          { timeout: 5000, stdio: "ignore" },
        );
      } catch {
        // The process may have exited before sampling starts.
      }
      child.kill("SIGKILL");
    }
    if (duplicate?.exitCode === null && duplicate.signalCode === null)
      duplicate.kill("SIGKILL");
  });
  try {
    if (!packaged) stopForge = await startForge();
    if (packaged) {
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    }
    const launch = async () => {
      mark(`launch-${++launches}`);
      const launched = await electron.launch(
        packaged
          ? {
              executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
              args: [`--user-data-dir=${profile}`],
            }
          : { args: [".", `--user-data-dir=${profile}`] },
      );
      applicationProcess = launched.process();
      mark(`launch-${launches}-complete`);
      return launched;
    };
    const close = async () => {
      mark(`close-${launches}`);
      await app!.close();
      mark(`close-${launches}-complete`);
    };
    const waitForDocument = async () => {
      mark(`window-${launches}`);
      const window = await app!.firstWindow();
      mark(`document-${launches}`);
      await window.waitForLoadState("load");
      mark(`document-${launches}-complete`);
      return window;
    };
    await mkdir(profile, { recursive: true });
    await writeFile(
      path.join(profile, "preferences.json"),
      JSON.stringify({
        version: 3,
        character: "corgi",
        visibility: "visible",
        size: 240,
      }),
    );
    mark("initial-launch");
    app = await launch();
    mark("initial-window");
    const pet = await waitForDocument();
    const visible = () =>
      app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isVisible(),
      );
    const invoke = async (label: string) => {
      mark(label);
      await app!.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "Mosey")
          ?.submenu?.items.find((item) => item.label === label);
        if (!item) throw new Error(`Missing menu item: ${label}`);
        item.click();
      }, label);
      mark(`${label}-complete`);
    };
    // Native visibility can precede the initial renderer document commit.
    // Wait for that document, then its actual drawing, before sampling frames.
    await expect
      .poll(
        () =>
          pet.evaluate(() => {
            const canvas = document.querySelector("canvas")!;
            return Array.from(
              canvas
                .getContext("2d")!
                .getImageData(0, 0, canvas.width, canvas.height).data,
            ).filter((value, i) => i % 4 === 3 && value > 127).length;
          }),
        { timeout: 10000 },
      )
      .toBeGreaterThan(5000);
    await expect.poll(visible).toBe(true);
    // Initial Vite dependency optimization may reload the development document.
    mark("network-idle");
    await pet.waitForLoadState("networkidle");
    mark("animation");
    const pixels = () =>
      pet.evaluate(() => document.querySelector("canvas")!.toDataURL());
    const idleFrames = new Set<string>();
    const idleUntil = Date.now() + 2200;
    while (Date.now() < idleUntil) {
      idleFrames.add(await pixels());
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    // External renderer instrumentation only; the production app has no test hooks.
    await pet.evaluate(() => {
      const counts = { draws: 0 };
      Reflect.set(window, "visibilityEvidence", counts);
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      Reflect.set(
        CanvasRenderingContext2D.prototype,
        "drawImage",
        function (this: CanvasRenderingContext2D, ...args: unknown[]) {
          counts.draws++;
          return Reflect.apply(draw, this, args);
        },
      );
    });
    const idleWorkBefore = await pet.evaluate(() => ({
      ...Reflect.get(window, "visibilityEvidence"),
    }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const idleWorkAfter = await pet.evaluate(() => ({
      ...Reflect.get(window, "visibilityEvidence"),
    }));
    const idleWork = {
      draws: idleWorkAfter.draws - idleWorkBefore.draws,
    };
    // Observe low-frequency Canvas work without binding to its scheduling mechanism.
    expect(idleWork.draws).toBeGreaterThanOrEqual(1);
    expect(idleWork.draws).toBeLessThanOrEqual(4);
    await pet.mouse.click(120, 180);
    await expect
      .poll(async () => idleFrames.has(await pixels()), { interval: 30 })
      .toBe(false);
    mark("hide");
    await invoke("Hide Mosey");
    await expect.poll(visible).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const counts = () =>
      pet.evaluate(() => Reflect.get(window, "visibilityEvidence"));
    const stopped = await counts();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const afterHidden = await counts();
    expect(afterHidden).toEqual(stopped);
    mark("show");
    await invoke("Show Mosey");
    await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
    // Restoring must remain inactive and return to idle rather than resume the response.
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isFocused(),
      ),
    ).toBe(false);
    await invoke("Hide Mosey");
    await expect.poll(visible).toBe(false);
    mark("restart-hidden");
    await close();
    app = await launch();
    await waitForDocument();
    expect(await visible()).toBe(false);
    mark("duplicate");
    duplicate = spawn(
      app.process().spawnfile,
      [...(packaged ? [] : ["."]), `--user-data-dir=${profile}`],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        stdio: "ignore",
      },
    );
    await expect.poll(() => duplicate!.exitCode, { timeout: 10000 }).toBe(0);
    expect(await visible()).toBe(false);
    await invoke("Show Mosey");
    await expect.poll(visible).toBe(true);
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow, screen }) => {
          const pet = BrowserWindow.getAllWindows()[0]!;
          return (
            pet.getBounds().y + pet.getBounds().height ===
            screen.getPrimaryDisplay().workArea.y +
              screen.getPrimaryDisplay().workArea.height
          );
        }),
      )
      .toBe(true);
    expect(await pet.isClosed()).toBe(true);
    await close();
    app = undefined;
    mark("corrupt-primary");
    // A completed backup must survive an interrupted temporary write and a corrupt primary.
    await writeFile(path.join(profile, "preferences.json"), "{broken");
    await writeFile(path.join(profile, "preferences.json.tmp"), '{"version":1');
    app = await launch();
    await waitForDocument();
    expect(await visible()).toBe(false);
    await invoke("Show Mosey");
    await expect.poll(visible).toBe(true);
    await close();
    app = undefined;
    expect(
      JSON.parse(
        await readFile(path.join(profile, "preferences.json"), "utf8"),
      ),
    ).toMatchObject({
      version: 3,
      character: "corgi",
      visibility: "visible",
      size: 240,
    });
    mark("failed-commit");
    // A failed atomic commit must keep the recovered hidden intent and menu choice.
    await rm(path.join(profile, "preferences.json"));
    await mkdir(path.join(profile, "preferences.json"));
    app = await launch();
    await waitForDocument();
    expect(await visible()).toBe(false);
    await invoke("Show Mosey");
    expect(await visible()).toBe(false);
    // The menu still offers Show because no durable change succeeded.
    await invoke("Show Mosey");
    await close();
    app = undefined;
    mark("both-invalid");
    // If neither primary nor backup validates, defaults leave a visible, usable pet.
    await rm(path.join(profile, "preferences.json"), { recursive: true });
    await writeFile(
      path.join(profile, "preferences.json"),
      JSON.stringify({ version: 999, visibility: "hidden" }),
    );
    await writeFile(
      path.join(profile, "preferences.json.bak"),
      "broken backup",
    );
    app = await launch();
    const recovered = await waitForDocument();
    await expect.poll(visible).toBe(true);
    // Recovery is another cold renderer: load and native visibility can precede
    // atlas decoding. Keep the same first-paint allowance as initial startup.
    await expect
      .poll(
        () =>
          recovered.evaluate(() => {
            const canvas = document.querySelector("canvas")!;
            return Array.from(
              canvas
                .getContext("2d")!
                .getImageData(0, 0, canvas.width, canvas.height).data,
            ).filter((value, i) => i % 4 === 3 && value > 127).length;
          }),
        { timeout: 10000 },
      )
      .toBeGreaterThan(5000);
    const logPath = await app.evaluate(({ app }) =>
      process
        .getBuiltinModule("node:path")
        .join(app.getPath("logs"), "main.log"),
    );
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("Invalid pet preferences");
    expect(log).toContain("Unable to save pet visibility");
    expect((await stat(logPath)).size).toBeLessThanOrEqual(1024 * 1024);
    await mkdir("test-results", { recursive: true });
    await writeFile(
      `test-results/${packaged ? "packaged" : "development"}-visibility.json`,
      JSON.stringify(
        {
          idleRendererWorkOver1200Ms: idleWork,
          hiddenRendererWorkBefore: stopped,
          hiddenRendererWorkAfter: afterHidden,
          visibilityRestoredInactive: true,
          launches: 5,
          recovery: [
            "corrupt-primary",
            "interrupted-temp",
            "failed-commit",
            "both-invalid",
          ],
          preservedSize: "large",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await mkdir("test-results", { recursive: true });
    for (const [index, window] of (app?.windows() ?? []).entries()) {
      await window
        .screenshot({
          path: `test-results/failure-${packaged ? "packaged" : "development"}-visibility-${index}.png`,
          timeout: 3000,
        })
        .catch(() => {});
    }
    throw error;
  } finally {
    mark("cleanup");
    if (duplicate?.exitCode === null) duplicate.kill();
    await app?.close().catch(() => {});
    await stopForge?.();
    await rm(root, { recursive: true, force: true });
    mark("done");
  }
});
