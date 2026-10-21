import { startForge } from "./support/forge";
import { test, expect } from "vitest";
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

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

test("manual visibility survives restart, duplicate launches and damaged preferences", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-visibility-"));
  const profile = path.join(root, "profile");
  let stopForge: (() => Promise<void>) | undefined;
  let duplicate: ChildProcess | undefined;
  let app: ElectronApplication | undefined;
  const navigationEvidence: unknown[] = [];
  try {
    if (!packaged) stopForge = await startForge();
    if (packaged) {
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    }
    const launch = () =>
      electron.launch(
        packaged
          ? {
              executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
              args: [`--user-data-dir=${profile}`],
            }
          : { args: [".", `--user-data-dir=${profile}`] },
      );
    await mkdir(profile, { recursive: true });
    await writeFile(
      path.join(profile, "preferences.json"),
      JSON.stringify({ version: 1, visibility: "visible", size: "large" }),
    );
    app = await launch();
    const pet = await app.firstWindow();
    navigationEvidence.push({
      event: "firstWindow",
      at: Date.now(),
      url: pet.url(),
    });
    pet.on("framenavigated", (frame) => {
      if (frame === pet.mainFrame())
        navigationEvidence.push({
          event: "framenavigated",
          at: Date.now(),
          url: frame.url(),
        });
    });
    pet.on("load", () =>
      navigationEvidence.push({
        event: "load",
        at: Date.now(),
        url: pet.url(),
      }),
    );
    pet.on("console", (message) => {
      if (message.text().includes("[vite]"))
        navigationEvidence.push({
          event: "vite-console",
          at: Date.now(),
          message: message.text(),
        });
    });
    navigationEvidence.push(
      await app.evaluate(({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows()[0]!;
        return {
          event: "initial-native",
          at: Date.now(),
          visible: pet.isVisible(),
          loading: pet.webContents.isLoading(),
          url: pet.webContents.getURL(),
          bounds: pet.getBounds(),
        };
      }),
    );
    const visible = () =>
      app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isVisible(),
      );
    const invoke = (label: string) =>
      app!.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "Mosey")
          ?.submenu?.items.find((item) => item.label === label);
        if (!item) throw new Error(`Missing menu item: ${label}`);
        item.click();
      }, label);
    // Native visibility can precede the initial renderer document commit.
    // Wait for that document, then its actual drawing, before sampling frames.
    await pet.waitForLoadState("load");
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
    navigationEvidence.push(
      await app.evaluate(({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows()[0]!;
        return {
          event: "visible-native",
          at: Date.now(),
          visible: pet.isVisible(),
          loading: pet.webContents.isLoading(),
          url: pet.webContents.getURL(),
          bounds: pet.getBounds(),
        };
      }),
    );
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
      const counts = { frames: 0, draws: 0 };
      Reflect.set(window, "visibilityEvidence", counts);
      const raf = window.requestAnimationFrame;
      window.requestAnimationFrame = (callback) =>
        raf((time) => {
          counts.frames++;
          callback(time);
        });
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
    await pet.mouse.click(120, 180);
    await expect
      .poll(async () => idleFrames.has(await pixels()), { interval: 30 })
      .toBe(false);
    await invoke("Hide Mosey");
    await expect.poll(visible).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const counts = () =>
      pet.evaluate(() => Reflect.get(window, "visibilityEvidence"));
    const stopped = await counts();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const afterHidden = await counts();
    expect(afterHidden).toEqual(stopped);
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
    await app.close();
    app = await launch();
    await (await app.firstWindow()).waitForLoadState("load");
    expect(await visible()).toBe(false);
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
    await app.close();
    app = undefined;
    // A completed backup must survive an interrupted temporary write and a corrupt primary.
    await writeFile(path.join(profile, "preferences.json"), "{broken");
    await writeFile(path.join(profile, "preferences.json.tmp"), '{"version":1');
    app = await launch();
    await (await app.firstWindow()).waitForLoadState("load");
    expect(await visible()).toBe(false);
    await invoke("Show Mosey");
    await expect.poll(visible).toBe(true);
    await app.close();
    app = undefined;
    expect(
      JSON.parse(
        await readFile(path.join(profile, "preferences.json"), "utf8"),
      ),
    ).toMatchObject({ version: 1, visibility: "visible", size: "large" });
    // A failed atomic commit must keep the recovered hidden intent and menu choice.
    await rm(path.join(profile, "preferences.json"));
    await mkdir(path.join(profile, "preferences.json"));
    app = await launch();
    await (await app.firstWindow()).waitForLoadState("load");
    expect(await visible()).toBe(false);
    await invoke("Show Mosey");
    expect(await visible()).toBe(false);
    // The menu still offers Show because no durable change succeeded.
    await invoke("Show Mosey");
    await app.close();
    app = undefined;
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
    const recovered = await app.firstWindow();
    await recovered.waitForLoadState("load");
    await expect.poll(visible).toBe(true);
    await expect
      .poll(() =>
        recovered.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          return Array.from(
            canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height).data,
          ).filter((value, i) => i % 4 === 3 && value > 127).length;
        }),
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
    console.error(
      "[DEBUG-visibility-navigation]",
      JSON.stringify(navigationEvidence),
    );
    await writeFile(
      `test-results/${packaged ? "packaged" : "development"}-visibility-navigation.json`,
      JSON.stringify(navigationEvidence, null, 2),
    );
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
    if (duplicate?.exitCode === null) duplicate.kill();
    await app?.close().catch(() => {});
    await stopForge?.();
    await rm(root, { recursive: true, force: true });
  }
});
