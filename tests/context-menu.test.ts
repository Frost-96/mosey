import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { startForge } from "./support/forge";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
// Exercise the CI 1x raster path on Retina developer machines too.
const scaleArgument = `--force-device-scale-factor=${process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"}`;
test("body secondary clicks open a native menu and cancel without changing the pet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-menu-"));
  let app: ElectronApplication | undefined;
  let stopForge: (() => Promise<void>) | undefined;
  try {
    if (!packaged) stopForge = await startForge();
    else
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [scaleArgument, `--user-data-dir=${root}/profile`],
          }
        : { args: [".", scaleArgument, `--user-data-dir=${root}/profile`] },
    );
    const pet = await app.firstWindow();
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
        const points: { x: number; y: number }[] = [];
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            if (data[(y * width + x) * 4 + 3]! > 200) points.push({ x, y });
        const point = points[Math.floor(points.length / 2)]!;
        return { x: (point.x * 240) / width, y: (point.y * 240) / height };
      });
    const openMenu = async (control = false) => {
      const count = await menuCount();
      const point = await body();
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
    await openMenu();
    await expect.poll(menuCount).toBe(1);
    const labels = await app.evaluate(() =>
      Reflect.get(globalThis, "menus")[0].items.map(
        (item: { label: string }) => item.label,
      ),
    );
    expect(labels).toEqual(["Hide Mosey", "Quit Mosey"]);
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
    // A native Control-click must not enter the ordinary left-button gesture.
    await openMenu(true);
    await closeMenu();
    await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
    await pet.mouse.click(120, 180);
    await expect
      .poll(async () => idleFrames.has(await pixels()), { interval: 20 })
      .toBe(false);
    await openMenu();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const reaction = await pixels();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect((await pixels()) === reaction).toBe(true);
    await closeMenu();
    expect(idleFrames.has(await pixels())).toBe(false);
    await expect
      .poll(async () => idleFrames.has(await pixels()), {
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
    const ground = await bounds();
    await pet.mouse.move(120, 180);
    await pet.mouse.down();
    await pet.mouse.move(120, 40, { steps: 4 });
    await expect
      .poll(async () => (await bounds()).y)
      .toBeLessThan(ground.y - 80);
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
    await openMenu();
    const falling = { pixels: await pixels(), bounds: await bounds() };
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await pixels()) === falling.pixels).toBe(true);
    expect(await bounds()).toEqual(falling.bounds);
    await closeMenu();
    await expect
      .poll(async () => (await bounds()).y, { timeout: 4000, interval: 10 })
      .toBe(ground.y);
    await openMenu();
    const landing = await pixels();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await pixels()) === landing).toBe(true);
    expect((await bounds()).y).toBe(ground.y);
    await closeMenu();
    await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
    // Preserve both a native-state deadline and in-progress desktop movement.
    await app.evaluate(() => {
      Math.random = () => 0.1;
      const timeout = globalThis.setTimeout;
      Reflect.set(globalThis, "unshortenedTimeout", timeout);
      globalThis.setTimeout = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        timeout(
          callback,
          delay && delay >= 10000 ? 800 : delay,
          ...args,
        )) as typeof setTimeout;
    });
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    const walkOrigin = await bounds();
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
    await closeMenu();
    const justResumed = await bounds();
    expect(Math.abs(justResumed.x - walking.bounds.x)).toBeLessThan(20);
    await expect
      .poll(async () => Math.abs((await bounds()).x - walkOrigin.x), {
        timeout: 3000,
        interval: 25,
      })
      .toBeGreaterThan(140);
    await app.evaluate(() => {
      globalThis.setTimeout = Reflect.get(globalThis, "unshortenedTimeout");
    });
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    await expect
      .poll(async () => idleFrames.has(await pixels()), { timeout: 2000 })
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
    await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
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
    await expect.poll(async () => idleFrames.has(await pixels())).toBe(true);
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
          ],
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
    await stopForge?.();
    await rm(root, { recursive: true, force: true });
  }
});
