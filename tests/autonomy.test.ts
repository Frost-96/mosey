import { emptyDockCapture } from "./support/empty-dock";
import { distanceFromGround } from "./support/ground";
import { startForge } from "./support/forge";
import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
const whale = process.env.MOSEY_TEST_CHARACTER === "whale";
const characterArguments = whale ? ["--character-sample=whale"] : [];
const evidence = `${packaged ? "packaged" : "development"}${whale ? "-whale" : ""}`;
const scaleArgument = `--force-device-scale-factor=${process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"}`;
test("autonomous activities stay grounded, yield to interaction and pause without catch-up", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-autonomy-"));
  let app: ElectronApplication | undefined;
  let stopForge: (() => Promise<void>) | undefined;
  let restoreDockCapture: (() => Promise<void>) | undefined;
  await mkdir("test-results", { recursive: true });
  const tracePath = `test-results/${evidence}-autonomy-progress.jsonl`;
  await writeFile(tracePath, "");
  const checkpoint = (stage: string) => {
    const entry = JSON.stringify({ stage, at: performance.now() });
    appendFileSync(tracePath, `${entry}\n`);
    console.log(`[autonomy-progress] ${entry}`);
  };
  try {
    await mkdir(path.join(root, "profile"), { recursive: true });
    await writeFile(
      path.join(root, "profile/preferences.json"),
      JSON.stringify({ version: 2, size: 240, visibility: "visible" }),
    );
    if (!packaged) stopForge = await startForge();
    else
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    restoreDockCapture = await emptyDockCapture(
      packaged
        ? path.join(root, "Mosey.app/Contents/Resources/native/dock-runtime")
        : path.resolve("build/native/dock-runtime"),
    );
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [
              ...characterArguments,
              scaleArgument,
              `--user-data-dir=${root}/profile`,
            ],
          }
        : {
            args: [
              ".",
              ...characterArguments,
              scaleArgument,
              `--user-data-dir=${root}/profile`,
            ],
          },
    );
    const pet = await app.firstWindow();
    // Bounded public-boundary diagnostics only. These do not change menu
    // selection, timing expectations or the asserted visibility intent.
    await app.evaluate(({ Menu, BrowserWindow, powerMonitor, app, screen }) => {
      const trace: unknown[] = [];
      const snapshot = (event: string, detail?: unknown) => {
        trace.push({
          event,
          detail,
          pointer: screen.getCursorScreenPoint(),
          at: performance.now(),
          wall: Date.now(),
          applicationHidden: app.isHidden(),
          menus: Menu.getApplicationMenu()?.items.map((item) => ({
            label: item.label,
            role: item.role,
            items: item.submenu?.items.map((child) => ({
              label: child.label,
              role: child.role,
            })),
          })),
          windows: BrowserWindow.getAllWindows().map((window) => ({
            id: window.id,
            visible: window.isVisible(),
            bounds: window.getBounds(),
          })),
        });
        if (trace.length > 128) trace.shift();
      };
      const setMenu = Menu.setApplicationMenu.bind(Menu);
      Menu.setApplicationMenu = (menu) => {
        setMenu(menu);
        snapshot("setApplicationMenu");
      };
      for (const window of BrowserWindow.getAllWindows()) {
        window.on("move", () => snapshot("move"));
        window.on("show", () => snapshot("show"));
        window.on("hide", () => snapshot("hide"));
        window.on("blur", () => snapshot("blur"));
        window.on("focus", () => snapshot("focus"));
      }
      screen.on("display-metrics-changed", (_event, display, changed) =>
        snapshot("display-metrics-changed", { display, changed }),
      );
      screen.on("display-added", (_event, display) =>
        snapshot("display-added", display),
      );
      screen.on("display-removed", (_event, display) =>
        snapshot("display-removed", display),
      );
      powerMonitor.on("suspend", () => snapshot("suspend"));
      powerMonitor.on("resume", () => snapshot("resume"));
      powerMonitor.on("lock-screen", () => snapshot("lock-screen"));
      powerMonitor.on("unlock-screen", () => snapshot("unlock-screen"));
      Object.assign(globalThis, { autonomyMenuTrace: trace });
      snapshot("observe");
    });
    const bounds = () =>
      app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBounds(),
      );
    const invoke = (label: string) =>
      app!.evaluate(async ({ Menu, BrowserWindow, app }, label) => {
        const menu = Menu.getApplicationMenu();
        const item = menu?.items
          .find((entry) => entry.label === "Mosey")
          ?.submenu?.items.find((entry) => entry.label === label);
        if (!item)
          throw new Error(
            JSON.stringify({
              requested: label,
              menus: menu?.items.map((entry) => ({
                label: entry.label,
                role: entry.role,
                items: entry.submenu?.items.map((child) => ({
                  label: child.label,
                  role: child.role,
                })),
              })),
              hidden: app.isHidden(),
              windows: BrowserWindow.getAllWindows().map((window) => ({
                visible: window.isVisible(),
                bounds: window.getBounds(),
              })),
            }),
          );
        // Cocoa delivers the public hide/show event after the menu callback.
        // Wait for that boundary before positioning or driving the pet; an
        // in-flight visibility transition can otherwise replace setup geometry.
        const target = BrowserWindow.getAllWindows()[0]!;
        const event =
          label === "Hide Mosey"
            ? "hide"
            : label === "Show Mosey"
              ? "show"
              : undefined;
        if (!event) {
          item.click();
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const settled = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            if (event === "hide") target.removeListener("hide", settled);
            else target.removeListener("show", settled);
            reject(new Error(`No public ${event} event after ${label}`));
          }, 5000);
          if (event === "hide") target.once("hide", settled);
          else target.once("show", settled);
          item.click();
        });
      }, label);
    await pet.locator("canvas").waitFor();
    await pet.waitForLoadState("networkidle");
    await pet.evaluate(() => {
      const trace: unknown[] = [];
      Reflect.set(window, "autonomyInputTrace", trace);
      for (const type of [
        "pointerdown",
        "pointerup",
        "pointermove",
        "pointercancel",
        "gotpointercapture",
        "lostpointercapture",
      ]) {
        window.addEventListener(
          type,
          (event) => {
            const pointer = event as PointerEvent;
            trace.push({
              type,
              at: performance.now(),
              wall: Date.now(),
              buttons: pointer.buttons,
              button: pointer.button,
              pointerId: pointer.pointerId,
              clientX: pointer.clientX,
              clientY: pointer.clientY,
              screenX: pointer.screenX,
              screenY: pointer.screenY,
            });
            if (trace.length > 128) trace.shift();
          },
          true,
        );
      }
    });
    const pixels = () =>
      pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL();
      });
    // networkidle can precede image decode and the first Canvas paint. Start
    // the full reference cycle only once a substantial upright corgi is visible.
    await expect
      .poll(
        () =>
          pet.evaluate(() => {
            const canvas = document.querySelector("canvas")!;
            const data = canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height).data;
            let opaque = 0,
              top = canvas.height,
              bottom = -1;
            for (let y = 0; y < canvas.height; y++)
              for (let x = 0; x < canvas.width; x++)
                if (data[(y * canvas.width + x) * 4 + 3]! >= 128) {
                  opaque++;
                  top = Math.min(top, y);
                  bottom = Math.max(bottom, y);
                }
            return opaque > 5000 && (bottom - top + 1) / devicePixelRatio > 180;
          }),
        { timeout: 5000, interval: 50 },
      )
      .toBe(true);
    const idleFrames = new Set<string>();
    const observedIdle = new Set<string>();
    const idleUntil = Date.now() + (whale ? 3100 : 2200);
    while (Date.now() < idleUntil) {
      const painted = await pixels();
      observedIdle.add(painted);
      idleFrames.add(painted);
      idleFrames.add(
        await pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          const mirror = document.createElement("canvas");
          mirror.width = canvas.width;
          mirror.height = canvas.height;
          const context = mirror.getContext("2d")!;
          context.translate(canvas.width, 0);
          context.scale(-1, 1);
          context.drawImage(canvas, 0, 0);
          context.getImageData(0, 0, mirror.width, mirror.height);
          return mirror.toDataURL();
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    expect(observedIdle.size).toBeGreaterThan(1);
    const references = [];
    for (const [index, url] of [...idleFrames].entries()) {
      const buffer = Buffer.from(url.split(",")[1]!, "base64");
      await writeFile(
        `test-results/${evidence}-autonomy-idle-${index}.png`,
        buffer,
      );
      const image = PNG.sync.read(buffer);
      let opaque = 0,
        top = image.height,
        bottom = -1;
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++)
          if (image.data[(y * image.width + x) * 4 + 3]! >= 128) {
            opaque++;
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
      references.push({
        index,
        width: image.width,
        height: image.height,
        opaque,
        top,
        bottom,
      });
    }
    await writeFile(
      `test-results/${evidence}-autonomy-baseline.json`,
      JSON.stringify(
        { observedFrames: observedIdle.size, references },
        null,
        2,
      ),
    );
    await mkdir("test-results", { recursive: true });
    await app.evaluate(() => {
      Math.random = () => 0.1;
      const timeout = globalThis.setTimeout;
      // Mock only the long rest clock, retaining real movement/animation time.
      globalThis.setTimeout = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        timeout(
          callback,
          delay && delay >= 10000 ? 1000 : delay,
          ...args,
        )) as typeof setTimeout;
    });
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    const origin = await bounds();
    await expect
      .poll(async () => Math.abs((await bounds()).x - origin.x), {
        timeout: 4500,
        interval: 50,
      })
      .toBeGreaterThan(15);
    await pet.screenshot({
      path: `test-results/${evidence}-walking.png`,
      omitBackground: true,
    });
    checkpoint("walking-screenshot-complete");
    const moving = await bounds();
    checkpoint("walking-bounds-complete");
    expect(moving.y).toBe(origin.y);
    expect(Math.abs(moving.x - origin.x)).toBeLessThan(181);
    checkpoint("walking-click-start");
    await pet.mouse.click(120, 180);
    checkpoint("walking-click-complete");
    const interrupted = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await bounds()).toEqual(interrupted);
    checkpoint("draw-observer-start");
    await pet.evaluate(() => {
      Reflect.set(window, "draws", 0);
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      Reflect.set(
        CanvasRenderingContext2D.prototype,
        "drawImage",
        function (this: CanvasRenderingContext2D, ...args: unknown[]) {
          Reflect.set(
            window,
            "draws",
            Number(Reflect.get(window, "draws")) + 1,
          );
          return Reflect.apply(draw, this, args);
        },
      );
    });
    checkpoint("suspend-start");
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("suspend");
    });
    checkpoint("suspend-complete");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const work = await pet.evaluate(() => Reflect.get(window, "draws"));
    const paused = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await pet.evaluate(() => Reflect.get(window, "draws"))).toBe(work);
    expect(await bounds()).toEqual(paused);
    checkpoint("resume-start");
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("resume");
    });
    checkpoint("resume-complete");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await bounds()).toEqual(paused);
    for (const [choice, action] of [
      [0.6, "stretching"],
      [0.9, "playing"],
    ] as const) {
      checkpoint(`${action}-start`);
      await app.evaluate((_electron, choice) => {
        Math.random = () => choice;
      }, choice);
      await invoke("Hide Mosey");
      await invoke("Show Mosey");
      const stationary = await bounds();
      checkpoint(`${action}-menu-complete`);
      await expect
        .poll(async () => idleFrames.has(await pixels()), {
          timeout: 2500,
          interval: 30,
        })
        .toBe(false);
      checkpoint(`${action}-pixels-complete`);
      // Skip the initial transition pose and capture the held bow/pounce.
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(idleFrames.has(await pixels())).toBe(false);
      await pet.screenshot({
        path: `test-results/${evidence}-${action}.png`,
        omitBackground: true,
      });
      checkpoint(`${action}-screenshot-complete`);
      expect(await bounds()).toEqual(stationary);
      await expect
        .poll(async () => idleFrames.has(await pixels()), {
          timeout: 3000,
          interval: 30,
        })
        .toBe(true);
    }
    await app.evaluate(() => {
      Math.random = () => 0.6;
    });
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    // Directed Playwright input does not move the physical OS cursor. Keep
    // this vertical drag away from it so native buttons=0/capture-loss events
    // do not cancel the simulated held pointer when the window moves beneath it.
    await app.evaluate(({ BrowserWindow, screen }) => {
      const pet = BrowserWindow.getAllWindows()[0]!;
      const area = screen.getPrimaryDisplay().workArea;
      const pointer = screen.getCursorScreenPoint();
      const x =
        pointer.x >= area.x + area.width / 2
          ? area.x
          : area.x + area.width - pet.getBounds().width;
      pet.setPosition(x, pet.getBounds().y, false);
    });
    const ground = await bounds();
    await expect
      .poll(async () => idleFrames.has(await pixels()), {
        timeout: 2500,
        interval: 30,
      })
      .toBe(false);
    await pet.mouse.move(120, 180);
    await pet.mouse.down();
    await pet.mouse.move(120, 60, { steps: 4 });
    await expect
      .poll(async () => (await bounds()).y)
      .toBeLessThan(ground.y - 80);
    const grabbed = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(await bounds()).toEqual(grabbed);
    await pet.mouse.up();
    await expect
      .poll(() => distanceFromGround(app!), { timeout: 4000 })
      .toBe(0);
    await expect
      .poll(async () => idleFrames.has(await pixels()), { timeout: 4000 })
      .toBe(true);
    // A new walk at the left boundary must turn inward and finish in a short range.
    await app.evaluate(() => {
      Math.random = () => 0.1;
    });
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    const edge = await app.evaluate(({ BrowserWindow, screen }) => {
      const pet = BrowserWindow.getAllWindows()[0]!;
      const area = screen.getPrimaryDisplay().workArea;
      pet.setPosition(area.x, area.y + area.height - pet.getBounds().height);
      return pet.getBounds();
    });
    await expect
      .poll(async () => (await bounds()).x, { timeout: 4500, interval: 50 })
      .toBeGreaterThan(edge.x + (whale ? 100 : 140));
    await expect
      .poll(async () => idleFrames.has(await pixels()), {
        timeout: 2000,
        interval: 30,
      })
      .toBe(true);
    const destination = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await bounds()).toEqual(destination);
    expect(destination.x).toBeLessThanOrEqual(edge.x + (whale ? 126 : 150));
    expect(destination.y).toBe(edge.y);
    await invoke("Hide Mosey");
    const hidden = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await bounds()).toEqual(hidden);
    await invoke("Show Mosey");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
    const held = await bounds();
    await pet.mouse.move(120, 180);
    await pet.mouse.down();
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(await bounds()).toEqual(held);
    const heldPixels = await pixels();
    await writeFile(
      `test-results/${evidence}-autonomy-held-canvas.png`,
      Buffer.from(heldPixels.split(",")[1]!, "base64"),
    );
    expect(idleFrames.has(heldPixels)).toBe(true);
    await pet.mouse.up();
    await writeFile(
      `test-results/${evidence}-autonomy.json`,
      JSON.stringify(
        {
          origin,
          moving,
          interrupted,
          suspendStoppedWork: work,
          edge,
          destination,
          actions: ["walk", "stretch", "play"],
          restClock:
            "long delays >=10s shortened externally to 1s; movement/frame time real",
          input:
            "targeted Playwright window input; system suspend/resume event simulated",
        },
        null,
        2,
      ),
    );
    checkpoint("complete");
  } catch (error) {
    checkpoint("failure");
    await mkdir("test-results", { recursive: true });
    const externalState = await app
      ?.evaluate(({ Menu, BrowserWindow, app }) => ({
        applicationHidden: app.isHidden(),
        menus: Menu.getApplicationMenu()?.items.map((item) => ({
          label: item.label,
          role: item.role,
          items: item.submenu?.items.map((child) => ({
            label: child.label,
            role: child.role,
          })),
        })),
        windows: BrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          visible: window.isVisible(),
          bounds: window.getBounds(),
        })),
        trace: Reflect.get(globalThis, "autonomyMenuTrace"),
      }))
      .catch((failure: unknown) => ({ unavailable: String(failure) }));
    const inputTrace = await app
      ?.windows()[0]
      ?.evaluate(() => Reflect.get(window, "autonomyInputTrace"))
      .catch((failure: unknown) => ({ unavailable: String(failure) }));
    const preferences = await readFile(
      path.join(root, "profile/preferences.json"),
      "utf8",
    ).catch((failure: unknown) => `Unavailable: ${String(failure)}`);
    await writeFile(
      `test-results/failure-${evidence}-autonomy-state.json`,
      JSON.stringify({ externalState, inputTrace, preferences }, null, 2),
    );
    await app
      ?.windows()[0]
      ?.screenshot({
        path: `test-results/failure-${evidence}-autonomy.png`,
        timeout: 3000,
      })
      .catch(() => {});
    throw error;
  } finally {
    await app?.close().catch(() => {});
    await restoreDockCapture?.();
    await stopForge?.();
    await rm(root, { recursive: true, force: true });
  }
});
