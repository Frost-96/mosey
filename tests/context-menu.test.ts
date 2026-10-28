import {
  copyBehaviorDevelopmentApp,
  instrumentBehaviorApplication,
} from "./support/behavior-build";
import { controlBehavior, advanceRest } from "./support/controlled-behavior";
import { emptyDockCapture } from "./support/empty-dock";
import { distanceFromGround } from "./support/ground";
import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { startForge } from "./support/forge";
import { openSettings, closeSettings } from "./support/settings";
import { matchPaintedFrames } from "./support/pixels";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
// Exercise the CI 1x raster path on Retina developer machines too.
const scaleArgument = `--force-device-scale-factor=${process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"}`;
test("body secondary clicks open a native menu and cancel without changing the pet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-menu-"));
  let app: ElectronApplication | undefined;
  let stopForge: (() => Promise<void>) | undefined;
  let restoreDock: (() => Promise<void>) | undefined;
  try {
    await mkdir(path.join(root, "profile"), { recursive: true });
    await writeFile(
      path.join(root, "profile/preferences.json"),
      JSON.stringify({
        version: 3,
        character: "corgi",
        size: 240,
        visibility: "visible",
      }),
    );
    if (!packaged) stopForge = await startForge();
    else
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    if (!packaged) await copyBehaviorDevelopmentApp(root);
    await instrumentBehaviorApplication({ root, packaged });
    restoreDock = await emptyDockCapture(
      packaged
        ? path.join(root, "Mosey.app/Contents/Resources/native/dock-runtime")
        : path.join(root, "app/build/native/dock-runtime"),
    );
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [scaleArgument, `--user-data-dir=${root}/profile`],
          }
        : {
            args: [
              path.join(root, "app"),
              scaleArgument,
              `--user-data-dir=${root}/profile`,
            ],
          },
    );
    const pet = await app.firstWindow();
    expect(await pet.evaluate(() => devicePixelRatio)).toBe(
      Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
    );
    await pet.waitForLoadState("networkidle");
    await app.evaluate(({ Menu }) => {
      const popup = Menu.prototype.popup;
      Reflect.set(globalThis, "menus", []);
      Reflect.set(globalThis, "nativeEvents", []);
      Menu.prototype.popup = function (options) {
        Reflect.get(globalThis, "menus").push(this);
        this.on("menu-will-show", () => {
          Reflect.set(this, "testShown", true);
          Reflect.get(globalThis, "nativeEvents").push(["show", Date.now()]);
        });
        this.on("menu-will-close", () => {
          Reflect.set(this, "testClosed", true);
          Reflect.get(globalThis, "nativeEvents").push(["close", Date.now()]);
        });
        const callback = options?.callback;
        options = {
          ...options,
          callback: () => {
            Reflect.get(globalThis, "nativeEvents").push([
              "callback",
              Date.now(),
            ]);
            callback?.();
          },
        };
        return popup.call(this, options);
      };
    });
    const menuCount = () =>
      app!.evaluate(() => Reflect.get(globalThis, "menus").length);
    const pixels = () =>
      pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        // Body selection reads Canvas pixels too. Keep the reference and later
        // observations on the same readback path: at 1x, changing readback
        // history changes interpolated color/alpha rounding after idle draws.
        canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL();
      });
    const bounds = () =>
      app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBounds(),
      );
    let controlHeld = false;
    const releaseSecondary = async () => {
      await pet.mouse.up({ button: controlHeld ? "left" : "right" });
      if (controlHeld) await pet.keyboard.up("Control");
      controlHeld = false;
    };
    const closeMenu = async () => {
      await app!.evaluate(({ BrowserWindow }) =>
        Reflect.get(globalThis, "menus")
          .at(-1)
          .closePopup(BrowserWindow.getAllWindows()[0]),
      );
      await expect
        .poll(() =>
          app!.evaluate(
            () => Reflect.get(globalThis, "menus").at(-1).testClosed,
          ),
        )
        .toBe(true);
      await releaseSecondary();
      if (
        !(await app!.evaluate(() =>
          Reflect.get(globalThis, "trackingIntercepted"),
        ))
      )
        await new Promise((resolve) => setTimeout(resolve, 350));
    };
    const invoke = async (label: string) => {
      await app!.evaluate(
        ({ Menu }, label) =>
          Menu.getApplicationMenu()!
            .items.find((item) => item.label === "Mosey")!
            .submenu!.items.find((item) => item.label === label)!
            .click(),
        label,
      );
      if (label === "Show Mosey") {
        // Wait for actual new canvas work, including when stale pre-hide pixels
        // already resemble idle. Physical first-input acceptance is separate.
        const initial = await pixels();
        await expect.poll(pixels, { timeout: 2000 }).not.toBe(initial);
      }
    };
    const body = () =>
      pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const { data, width, height } = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height);
        // The median opaque pixel can be on an outline edge that disappears on the
        // next frame. Choose the deepest visible interior, not an arbitrary
        // pixel in scan order, so a moving-body click survives ordinary latency.
        const distance = new Uint16Array(width * height);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (data[index * 4 + 3]! > 200)
              distance[index] =
                1 +
                Math.min(
                  x ? distance[index - 1]! : 0,
                  y ? distance[index - width]! : 0,
                );
          }
        let deepest = 0;
        let point: { x: number; y: number } | undefined;
        for (let y = height - 1; y >= 0; y--)
          for (let x = width - 1; x >= 0; x--) {
            const index = y * width + x;
            if (distance[index])
              distance[index] = Math.min(
                distance[index]!,
                1 +
                  Math.min(
                    x < width - 1 ? distance[index + 1]! : 0,
                    y < height - 1 ? distance[index + width]! : 0,
                  ),
              );
            if (distance[index]! > deepest) {
              deepest = distance[index]!;
              point = { x, y };
            }
          }
        if (!point) throw new Error("No visible body for secondary click");
        const rect = canvas.getBoundingClientRect();
        return {
          x: ((point.x + 0.5) * rect.width) / width,
          y: ((point.y + 0.5) * rect.height) / height,
        };
      });
    const openMenu = async (
      control = false,
      afterTarget?: () => Promise<void>,
    ) => {
      const count = await menuCount();
      const point = await body();
      await afterTarget?.();
      controlHeld = control;
      if (control) await pet.keyboard.down("Control");
      await pet.mouse.move(point.x, point.y);
      await pet.mouse.down({ button: control ? "left" : "right" });
      await expect.poll(menuCount).toBe(count + 1);
      await expect
        .poll(() =>
          app!.evaluate(
            () => Reflect.get(globalThis, "menus").at(-1).testShown,
          ),
        )
        .toBe(true);
    };
    const idleFrames = new Set<string>();
    const idleUntil = Date.now() + 2200;
    while (Date.now() < idleUntil) {
      idleFrames.add(await pixels());
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
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const matchesIdle = matchPaintedFrames(idleFrames);
    await openMenu();
    await expect.poll(menuCount).toBe(1);
    const labels = await app.evaluate(() =>
      Reflect.get(globalThis, "menus")[0].items.map(
        (item: { label: string }) => item.label,
      ),
    );
    expect(labels).toContain("Pet Size");
    expect(labels).not.toContain("Dock validation");
    expect(
      await app.evaluate(() =>
        Reflect.get(globalThis, "menus")[0]
          .items.find((item: { label: string }) => item.label === "Pet Size")
          .submenu.items.map((item: { label: string; checked: boolean }) => ({
            label: item.label,
            checked: item.checked,
          })),
      ),
    ).toEqual([
      { label: "Small", checked: false },
      { label: "Medium", checked: false },
      { label: "Large", checked: true },
    ]);
    await closeMenu();
    await expect.poll(pixels, { timeout: 2000 }).not.toBe(await pixels());
    // Keep actual native show/items/cancel above. Long pause/progress assertions
    // replace only the OS menu tracking boundary: Cocoa may dismiss a popup
    // independently of Playwright's targeted input and physical cursor.
    await app.evaluate(({ Menu }) => {
      Reflect.set(globalThis, "trackingIntercepted", true);
      Menu.prototype.popup = function (options) {
        Reflect.get(globalThis, "menus").push(this);
        Reflect.set(this, "testShown", true);
        Reflect.set(this, "trackingCallback", options?.callback);
      };
      Menu.prototype.closePopup = function () {
        const callback = Reflect.get(this, "trackingCallback");
        Reflect.set(this, "trackingCallback", undefined);
        Reflect.set(this, "testClosed", true);
        callback?.();
      };
    });
    await openMenu();
    const frozen = await pixels();
    await new Promise((resolve) => setTimeout(resolve, 2400));
    expect((await pixels()) === frozen).toBe(true);
    await closeMenu();
    await expect.poll(pixels).not.toBe(frozen);
    await pet.mouse.click(5, 5, { button: "right" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await menuCount()).toBe(2);
    for (const [label, side] of [
      ["Small", 70],
      ["Medium", 160],
      ["Large", 240],
    ] as const) {
      await openMenu();
      const before = await bounds();
      await app.evaluate((_electron, label) => {
        Reflect.get(globalThis, "menus")
          .at(-1)
          .items.find((item: { label: string }) => item.label === "Pet Size")
          .submenu.items.find((item: { label: string }) => item.label === label)
          .click();
      }, label);
      await closeMenu();
      await expect.poll(async () => (await bounds()).width).toBe(side);
      const after = await bounds();
      expect(after.x + side / 2).toBe(before.x + before.width / 2);
      expect(after.y + side).toBe(before.y + before.height);
      expect(
        await app.evaluate(({ Menu }) =>
          Menu.getApplicationMenu()!
            .items.find((item) => item.label === "Mosey")!
            .submenu!.items.find((item) => item.label === "Pet Size")!
            .submenu!.items.filter((item) => item.checked)
            .map((item) => item.label),
        ),
      ).toEqual([label]);
      await expect.poll(pixels).not.toBe(await pixels());
      await openMenu();
      expect(
        await app.evaluate(() =>
          Reflect.get(globalThis, "menus")
            .at(-1)
            .items.find((item: { label: string }) => item.label === "Pet Size")
            .submenu.items.filter((item: { checked: boolean }) => item.checked)
            .map((item: { label: string }) => item.label),
        ),
      ).toEqual([label]);
      await closeMenu();
    }
    const settings = await openSettings(app);
    const slider = settings.getByRole("slider", { name: "宠物大小" });
    await slider.focus();
    await settings.keyboard.press("Home");
    for (let step = 0; step < 4; step++)
      await settings.keyboard.press("ArrowRight");
    await settings.keyboard.press("Tab");
    await expect.poll(() => slider.inputValue()).toBe("110");
    await closeSettings(app);
    await openMenu();
    expect(
      await app.evaluate(() =>
        Reflect.get(globalThis, "menus")
          .at(-1)
          .items.find((item: { label: string }) => item.label === "Pet Size")
          .submenu.items.some((item: { checked: boolean }) => item.checked),
      ),
    ).toBe(false);
    await closeMenu();
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items.find((item) => item.label === "Mosey")!
        .submenu!.items.find((item) => item.label === "Pet Size")!
        .submenu!.items.find((item) => item.label === "Large")!
        .click(),
    );
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    // A native Control-click must not enter the ordinary left-button gesture.
    await openMenu(true);
    await closeMenu();
    await expect.poll(async () => matchesIdle(await pixels())).toBe(true);
    await pet.mouse.click(120, 180);
    await expect
      .poll(async () => matchesIdle(await pixels()), { interval: 20 })
      .toBe(false);
    await openMenu();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const reaction = await pixels();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect((await pixels()) === reaction).toBe(true);
    await closeMenu();
    expect(matchesIdle(await pixels())).toBe(false);
    await expect
      .poll(async () => matchesIdle(await pixels()), {
        interval: 25,
        timeout: 3000,
      })
      .toBe(true);
    // A secondary click during capture leaves the original drag in charge.
    await app.evaluate(({ BrowserWindow, screen }) => {
      const pet = BrowserWindow.getAllWindows()[0]!;
      const area = screen.getPrimaryDisplay().workArea;
      const cursor = screen.getCursorScreenPoint();
      pet.setPosition(
        cursor.x >= area.x + area.width / 2
          ? area.x
          : area.x + area.width - 240,
        pet.getBounds().y,
      );
    });
    // Let native hover from relocation settle before starting CDP capture.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ground = await bounds();
    await pet.mouse.move(120, 180);
    await pet.mouse.down();
    await pet.mouse.move(120, -120, { steps: 4 });
    await expect
      .poll(async () => (await bounds()).y)
      .toBeLessThan(ground.y - 200);
    const beforeRightDrag = await menuCount();
    await pet.mouse.down({ button: "right" });
    await pet.mouse.up({ button: "right" });
    expect(await menuCount()).toBe(beforeRightDrag);
    const held = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(await bounds()).toEqual(held);
    await pet.mouse.up();
    await openMenu();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const returning = { pixels: await pixels(), bounds: await bounds() };
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect((await pixels()) === returning.pixels).toBe(true);
    expect(await bounds()).toEqual(returning.bounds);
    await closeMenu();
    await expect
      .poll(async () => (await bounds()).y, { timeout: 3000, interval: 10 })
      .toBeGreaterThan(returning.bounds.y + 3);
    // Leave enough fall distance to observe two successive drawn frames. The
    // body target must remain inside the pet when input crosses a frame change.
    const firstFallingFrame = await pixels();
    await expect
      .poll(pixels, { timeout: 1000, interval: 5 })
      .not.toBe(firstFallingFrame);
    await openMenu(false, async () => {
      const selectedFrame = await pixels();
      await expect
        .poll(pixels, { timeout: 1000, interval: 5 })
        .not.toBe(selectedFrame);
    });
    const falling = { pixels: await pixels(), bounds: await bounds() };
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await pixels()) === falling.pixels).toBe(true);
    expect(await bounds()).toEqual(falling.bounds);
    await closeMenu();
    await expect
      .poll(() => distanceFromGround(app!), { timeout: 4000, interval: 10 })
      .toBe(0);
    await openMenu();
    const landing = await pixels();
    const landingBounds = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await pixels()) === landing).toBe(true);
    expect(await bounds()).toEqual(landingBounds);
    await closeMenu();
    await expect.poll(async () => matchesIdle(await pixels())).toBe(true);
    // Preserve both a native-state deadline and in-progress desktop movement.
    await controlBehavior(app, { random: 0.1 });
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    const walkOrigin = await bounds();
    await advanceRest(app, 0.1);
    await expect
      .poll(async () => Math.abs((await bounds()).x - walkOrigin.x), {
        timeout: 3000,
        interval: 20,
      })
      .toBeGreaterThan(15);
    await openMenu();
    const walking = { pixels: await pixels(), bounds: await bounds() };
    await new Promise((resolve) => setTimeout(resolve, 2900));
    expect((await pixels()) === walking.pixels).toBe(true);
    expect(await bounds()).toEqual(walking.bounds);
    await app.evaluate(() =>
      Reflect.get(globalThis, "menus")
        .at(-1)
        .items.find((item: { label: string }) => item.label === "Pet Size")
        .submenu.items.find(
          (item: { label: string }) => item.label === "Medium",
        )
        .click(),
    );
    await closeMenu();
    const justResumed = await bounds();
    expect(justResumed.width).toBe(160);
    expect(
      Math.abs(
        justResumed.x + 80 - walking.bounds.x - walking.bounds.width / 2,
      ),
    ).toBeLessThan(20);
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items.find((item) => item.label === "Mosey")!
        .submenu!.items.find((item) => item.label === "Pet Size")!
        .submenu!.items.find((item) => item.label === "Large")!
        .click(),
    );
    await expect
      .poll(async () => Math.abs((await bounds()).x - walkOrigin.x), {
        timeout: 3000,
        interval: 25,
      })
      .toBeGreaterThan(140);
    // Exercise the gap between the main-process activity deadline and its
    // first painted frame. Slow rendering must not be mistaken for inactivity.
    // Only the first stretch/play paint is delayed; the actual renderer and
    // native/menu pause behavior stay in charge of every subsequent assertion.
    await pet.evaluate(() => {
      const frame = requestAnimationFrame;
      const delayed = new Set<string>();
      Reflect.set(window, "restoreMenuFrames", () => {
        window.requestAnimationFrame = frame;
      });
      window.requestAnimationFrame = (callback) =>
        frame((time) => {
          const label =
            document.querySelector("canvas")?.getAttribute("aria-label") ?? "";
          if (/伸展|玩耍/.test(label) && !delayed.has(label)) {
            delayed.add(label);
            setTimeout(() => callback(time), 900);
          } else callback(time);
        });
    });
    const activityPaints = [];
    for (const choice of [0.6, 0.9]) {
      await controlBehavior(app, { random: choice });
      await invoke("Hide Mosey");
      await invoke("Show Mosey");
      const expectedLabel = choice === 0.6 ? "柯基 · 伸展" : "柯基 · 玩耍";
      const started = performance.now();
      await advanceRest(app, choice);
      await expect
        .poll(
          async () => ({
            label: await pet.locator("canvas").getAttribute("aria-label"),
            idlePixels: matchesIdle(await pixels()),
          }),
          { timeout: 3000, interval: 20 },
        )
        .toEqual({ label: expectedLabel, idlePixels: false });
      activityPaints.push({
        label: expectedLabel,
        elapsed: performance.now() - started,
      });
      await openMenu();
      const activity = { pixels: await pixels(), bounds: await bounds() };
      await new Promise((resolve) => setTimeout(resolve, 2400));
      expect(await pixels()).toBe(activity.pixels);
      expect(await bounds()).toEqual(activity.bounds);
      await closeMenu();
      await expect
        .poll(async () => matchesIdle(await pixels()), {
          timeout: 3000,
          interval: 25,
        })
        .toBe(true);
    }
    await pet.evaluate(() => Reflect.get(window, "restoreMenuFrames")());
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    await expect
      .poll(async () => matchesIdle(await pixels()), { timeout: 2000 })
      .toBe(true);
    // Exercise menu lifecycle when system suspension supersedes a body menu.
    await openMenu();
    await app.evaluate(({ Menu }) => {
      Reflect.set(globalThis, "trackedClosePopup", Menu.prototype.closePopup);
      // A platform popup that never finishes opening may provide no close
      // callback. Explicit lifecycle cancellation must still release its pause.
      Menu.prototype.closePopup = function () {};
    });
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("suspend");
    });
    await releaseSecondary();
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("resume");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const resumedPixels = await pixels();
    await expect.poll(pixels, { timeout: 2000 }).not.toBe(resumedPixels);
    await app.evaluate(({ Menu }) => {
      Menu.prototype.closePopup = Reflect.get(globalThis, "trackedClosePopup");
    });
    await expect.poll(async () => matchesIdle(await pixels())).toBe(true);
    await openMenu();
    await app.evaluate(() =>
      Reflect.get(globalThis, "menus")
        .at(-1)
        .items.find((item: { label: string }) => item.label === "Hide Mosey")
        .click(),
    );
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isVisible(),
        ),
      )
      .toBe(false);
    expect(
      JSON.parse(
        await readFile(path.join(root, "profile/preferences.json"), "utf8"),
      ).visibility,
    ).toBe("hidden");
    await releaseSecondary();
    await invoke("Show Mosey");
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isVisible(),
        ),
      )
      .toBe(true);
    await expect.poll(async () => matchesIdle(await pixels())).toBe(true);
    await openMenu();
    await app.evaluate(() =>
      Reflect.get(globalThis, "menus")
        .at(-1)
        .items.find((item: { label: string }) => item.label === "Pet Size")
        .submenu.items.find(
          (item: { label: string }) => item.label === "Medium",
        )
        .click(),
    );
    await closeMenu();
    await expect.poll(pixels).not.toBe(await pixels());
    await openMenu();
    const exited = app.waitForEvent("close");
    await app
      .evaluate(() => {
        Reflect.get(globalThis, "menus")
          .at(-1)
          .items.find((item: { label: string }) => item.label === "Quit Mosey")
          .click();
      })
      .catch(() => {});
    await exited;
    app = undefined;
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [scaleArgument, `--user-data-dir=${root}/profile`],
          }
        : {
            args: [
              path.join(root, "app"),
              scaleArgument,
              `--user-data-dir=${root}/profile`,
            ],
          },
    );
    await app.firstWindow();
    expect((await bounds()).width).toBe(160);
    expect(
      await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()!
          .items.find((item) => item.label === "Mosey")!
          .submenu!.items.find((item) => item.label === "Pet Size")!
          .submenu!.items.filter((item) => item.checked)
          .map((item) => item.label),
      ),
    ).toEqual(["Medium"]);
    await mkdir("test-results", { recursive: true });
    await writeFile(
      `test-results/${packaged ? "packaged" : "development"}-menu.json`,
      JSON.stringify(
        {
          nativeMenu:
            "actual first show/items/cancel; subsequent tracking boundary intercepted",
          inputs:
            "Playwright targeted right-click and Control-click; native Menu public API used for cancel/select",
          frozen: [
            "idle",
            "reaction",
            "flutter",
            "falling",
            "landing",
            "walking",
            "stretching",
            "playing",
          ],
          activityPaints,
          scaleFactor: Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
          dragSecondaryIgnored: true,
          systemSuspendClosesMenu: true,
          durableHiddenIntent: true,
          quitExited: true,
          desktopAcceptance: "not established by automated input",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.log(
      "Native menu events",
      await app?.evaluate(() => Reflect.get(globalThis, "nativeEvents")),
    );
    await mkdir("test-results", { recursive: true });
    await app
      ?.windows()[0]
      ?.screenshot({
        path: `test-results/failure-${packaged ? "packaged" : "development"}-menu.png`,
        timeout: 3000,
      })
      .catch(() => {});
    throw error;
  } finally {
    await app
      ?.evaluate(() => Reflect.get(globalThis, "menus")?.at(-1)?.closePopup())
      .catch(() => {});
    await app?.close().catch(() => {});
    await restoreDock?.();
    await stopForge?.();
    await rm(root, { recursive: true, force: true });
  }
});
