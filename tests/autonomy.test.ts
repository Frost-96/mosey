import { createPetTestSession } from "./support/pet-session";
import { controlBehavior, advanceRest } from "./support/controlled-behavior";
import { distanceFromGround } from "./support/ground";
import { waitForPetVisibility } from "./support/visibility";
import { test, expect } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
const whale = process.env.MOSEY_TEST_CHARACTER === "whale";
const evidence = `${packaged ? "packaged" : "development"}${whale ? "-whale" : ""}`;
test("autonomous activities stay grounded, yield to interaction and pause without catch-up", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    behavior: {},
    preferences: {
      version: 3,
      character: whale ? "whale" : "corgi",
      size: 240,
      visibility: "visible",
    },
  });
  const { app, pet } = await session.launch();
  // Vite may finish dependency optimization after the first painted frame.
  await session.run("startup-network-idle", () =>
    pet.waitForLoadState("networkidle"),
  );
  const checkpoint = (stage: string) => session.mark(stage);
  try {
    // Bounded public-boundary diagnostics only. These do not change menu
    // selection, timing expectations or the asserted visibility intent.
    await session.run("autonomy:app-evaluate", () =>
      app.evaluate(({ Menu, BrowserWindow, powerMonitor, app, screen }) => {
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
      }),
    );
    const bounds = () =>
      session.run("autonomy:app-evaluate", () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.getBounds(),
        ),
      );
    const invoke = async (label: string) => {
      await session.run("autonomy:app-evaluate", () =>
        app.evaluate(({ Menu, BrowserWindow, app }, label) => {
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
          item.click();
        }, label),
      );
      if (label === "Hide Mosey" || label === "Show Mosey")
        await waitForPetVisibility(
          app,
          pet,
          label === "Hide Mosey" ? "hidden" : "visible",
          { run: session.run },
        );
    };
    await session.run("autonomy:pet-evaluate", () =>
      pet.evaluate(() => {
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
      }),
    );
    const pixels = () =>
      session.run("autonomy:pet-evaluate", () =>
        pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height);
          return canvas.toDataURL();
        }),
      );
    // networkidle can precede image decode and the first Canvas paint. Start
    // the full reference cycle only once a substantial upright corgi is visible.
    await expect
      .poll(
        () =>
          session.run("autonomy:pet-evaluate", () =>
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
              return (
                opaque > 5000 && (bottom - top + 1) / devicePixelRatio > 180
              );
            }),
          ),
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
        await session.run("autonomy:pet-evaluate", () =>
          pet.evaluate(() => {
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
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    expect(observedIdle.size).toBeGreaterThan(1);
    const references: {
      index: number;
      width: number;
      height: number;
      opaque: number;
      top: number;
      bottom: number;
    }[] = [];
    for (const [index, url] of [...idleFrames].entries()) {
      const buffer = Buffer.from(url.split(",")[1]!, "base64");
      await session.run("autonomy:writeFile", () =>
        writeFile(
          `test-results/${evidence}-autonomy-idle-${index}.png`,
          buffer,
        ),
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
    await session.run("autonomy:writeFile", () =>
      writeFile(
        `test-results/${evidence}-autonomy-baseline.json`,
        JSON.stringify(
          { observedFrames: observedIdle.size, references },
          null,
          2,
        ),
      ),
    );
    await session.run("autonomy:controlBehavior", () =>
      controlBehavior(app, { random: 0.1 }),
    );
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    const origin = await bounds();
    await advanceRest(app, 0.1, session.run);
    await expect
      .poll(async () => Math.abs((await bounds()).x - origin.x), {
        timeout: 4500,
        interval: 50,
      })
      .toBeGreaterThan(15);
    await session.run("autonomy:pet-screenshot", () =>
      pet.screenshot({
        path: `test-results/${evidence}-walking.png`,
        omitBackground: true,
      }),
    );
    checkpoint("walking-screenshot-complete");
    const moving = await bounds();
    checkpoint("walking-bounds-complete");
    expect(moving.y).toBe(origin.y);
    expect(Math.abs(moving.x - origin.x)).toBeLessThan(181);
    checkpoint("walking-click-start");
    await session.run("autonomy:pet-mouse-click", () =>
      pet.mouse.click(120, 180),
    );
    checkpoint("walking-click-complete");
    const interrupted = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await bounds()).toEqual(interrupted);
    checkpoint("draw-observer-start");
    await session.run("autonomy:pet-evaluate", () =>
      pet.evaluate(() => {
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
      }),
    );
    checkpoint("suspend-start");
    await session.run("autonomy:app-evaluate", () =>
      app.evaluate(({ powerMonitor }) => {
        powerMonitor.emit("suspend");
      }),
    );
    checkpoint("suspend-complete");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const work = await session.run("autonomy:pet-evaluate", () =>
      pet.evaluate(() => Reflect.get(window, "draws")),
    );
    const paused = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(
      await session.run("autonomy:pet-evaluate", () =>
        pet.evaluate(() => Reflect.get(window, "draws")),
      ),
    ).toBe(work);
    expect(await bounds()).toEqual(paused);
    checkpoint("resume-start");
    await session.run("autonomy:app-evaluate", () =>
      app.evaluate(({ powerMonitor }) => {
        powerMonitor.emit("resume");
      }),
    );
    checkpoint("resume-complete");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await bounds()).toEqual(paused);
    for (const [choice, action] of [
      [0.6, "stretching"],
      [0.9, "playing"],
    ] as const) {
      checkpoint(`${action}-start`);
      await session.run("autonomy:controlBehavior", () =>
        controlBehavior(app, { random: choice }),
      );
      await invoke("Hide Mosey");
      await invoke("Show Mosey");
      const stationary = await bounds();
      await advanceRest(app, choice, session.run);
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
      await session.run("autonomy:pet-screenshot", () =>
        pet.screenshot({
          path: `test-results/${evidence}-${action}.png`,
          omitBackground: true,
        }),
      );
      checkpoint(`${action}-screenshot-complete`);
      expect(await bounds()).toEqual(stationary);
      await expect
        .poll(async () => idleFrames.has(await pixels()), {
          timeout: 3000,
          interval: 30,
        })
        .toBe(true);
    }
    await session.run("autonomy:controlBehavior", () =>
      controlBehavior(app, { random: 0.6 }),
    );
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    // Directed Playwright input does not move the physical OS cursor. Keep
    // this vertical drag away from it so native buttons=0/capture-loss events
    // do not cancel the simulated held pointer when the window moves beneath it.
    await session.run("autonomy:app-evaluate", () =>
      app.evaluate(({ BrowserWindow, screen }) => {
        const pet = BrowserWindow.getAllWindows()[0]!;
        const area = screen.getPrimaryDisplay().workArea;
        const pointer = screen.getCursorScreenPoint();
        const x =
          pointer.x >= area.x + area.width / 2
            ? area.x
            : area.x + area.width - pet.getBounds().width;
        pet.setPosition(x, pet.getBounds().y, false);
      }),
    );
    const ground = await bounds();
    await advanceRest(app, 0.6, session.run);
    await expect
      .poll(async () => idleFrames.has(await pixels()), {
        timeout: 2500,
        interval: 30,
      })
      .toBe(false);
    await session.run("autonomy:pet-mouse-move", () =>
      pet.mouse.move(120, 180),
    );
    await session.run("autonomy:pet-mouse-down", () => pet.mouse.down());
    await session.run("autonomy:pet-mouse-move", () =>
      pet.mouse.move(120, 60, { steps: 4 }),
    );
    await expect
      .poll(async () => (await bounds()).y)
      .toBeLessThan(ground.y - 80);
    const grabbed = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(await bounds()).toEqual(grabbed);
    await session.run("autonomy:pet-mouse-up", () => pet.mouse.up());
    await expect
      .poll(
        () =>
          session.run("autonomy:distanceFromGround", () =>
            distanceFromGround(app),
          ),
        { timeout: 4000 },
      )
      .toBe(0);
    await expect
      .poll(async () => idleFrames.has(await pixels()), { timeout: 4000 })
      .toBe(true);
    // A new walk at the left boundary must turn inward and finish in a short range.
    await session.run("autonomy:controlBehavior", () =>
      controlBehavior(app, { random: 0.1 }),
    );
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    const edge = await session.run("autonomy:app-evaluate", () =>
      app.evaluate(({ BrowserWindow, screen }) => {
        const pet = BrowserWindow.getAllWindows()[0]!;
        const area = screen.getPrimaryDisplay().workArea;
        pet.setPosition(area.x, area.y + area.height - pet.getBounds().height);
        return pet.getBounds();
      }),
    );
    await advanceRest(app, 0.1, session.run);
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
    await session.run("autonomy:pet-mouse-move", () =>
      pet.mouse.move(120, 180),
    );
    await session.run("autonomy:pet-mouse-down", () => pet.mouse.down());
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(await bounds()).toEqual(held);
    const heldPixels = await pixels();
    await session.run("autonomy:writeFile", () =>
      writeFile(
        `test-results/${evidence}-autonomy-held-canvas.png`,
        Buffer.from(heldPixels.split(",")[1]!, "base64"),
      ),
    );
    expect(idleFrames.has(heldPixels)).toBe(true);
    await session.run("autonomy:pet-mouse-up", () => pet.mouse.up());
    await session.run("autonomy:writeFile", () =>
      writeFile(
        `test-results/${evidence}-autonomy.json`,
        JSON.stringify(
          {
            sessionEvidence: session.evidence,
            origin,
            moving,
            interrupted,
            suspendStoppedWork: work,
            edge,
            destination,
            actions: ["walk", "stretch", "play"],
            behaviorTime:
              "controlled behavior adapter advances rest eligibility; movement and painted animation run at real elapsed speed",
            input:
              "targeted Playwright window input; system suspend/resume event simulated",
          },
          null,
          2,
        ),
      ),
    );
    checkpoint("complete");
    await session.quit();
  } catch (error) {
    const externalState = await session
      .run("autonomy:app-evaluate", () =>
        app.evaluate(({ Menu, BrowserWindow, app }) => ({
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
        })),
      )
      .catch((failure: unknown) => ({ unavailable: String(failure) }));
    const inputTrace = await session
      .run("autonomy:pet-evaluate", () =>
        pet.evaluate(() => Reflect.get(window, "autonomyInputTrace")),
      )
      .catch((failure: unknown) => ({ unavailable: String(failure) }));
    const preferences = await session
      .run("autonomy:readFile", () =>
        readFile(path.join(session.profile, "preferences.json"), "utf8"),
      )
      .catch((failure: unknown) => `Unavailable: ${String(failure)}`);
    await session
      .run("autonomy:writeFile", () =>
        writeFile(
          `test-results/failure-${evidence}-autonomy-state.json`,
          JSON.stringify({ externalState, inputTrace, preferences }, null, 2),
        ),
      )
      .catch(() => {});
    await session
      .run("autonomy-failure-screenshot", () =>
        pet.screenshot({
          path: `test-results/failure-${evidence}-autonomy.png`,
          timeout: 3000,
        }),
      )
      .catch(() => {});
    throw error;
  }
});
