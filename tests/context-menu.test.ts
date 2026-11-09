import { evidencePath } from "./support/evidence";
import { distanceFromGround } from "./support/ground";
import { observeGeometry } from "./support/geometry-observer";
import { test, expect } from "vitest";
import type { ElectronApplication } from "playwright";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { openSettings, closeSettings } from "./support/settings";
import { matchPaintedFrames, paintedBodyPoint } from "./support/pixels";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("body menus keep the pet active and close without replaying actions", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      size: 240,
      visibility: "visible",
    },
  });
  let app: ElectronApplication | undefined;
  try {
    const launched = await session.launch();
    app = launched.app;
    const pet = launched.pet;
    const geometry = await observeGeometry(app, pet, "context-menu");
    session.mark("native-menu-scenarios");
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
    const body = () => pet.evaluate(paintedBodyPoint, 200);
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
    const current = () => pet.evaluate(() => window.mosey.getPresentation());
    const waitPosture = (posture: string, timeout = 4000) =>
      expect
        .poll(async () => (await current()).posture, { timeout, interval: 10 })
        .toBe(posture);
    // Keep actual native show/items/cancel above. Long progress assertions
    // replace only the OS menu tracking boundary: Cocoa may dismiss a popup
    // independently of Playwright's targeted input and physical cursor.
    await app.evaluate(({ Menu, BrowserWindow, screen }) => {
      Reflect.set(globalThis, "trackingIntercepted", true);
      Menu.prototype.popup = function (options) {
        Reflect.get(globalThis, "menus").push(this);
        Reflect.set(this, "testShown", true);
        const bounds = BrowserWindow.getAllWindows()[0]!.getBounds();
        const area = screen.getPrimaryDisplay().workArea;
        Reflect.set(this, "testOpened", {
          bounds,
          ground: area.y + area.height - bounds.height,
        });
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
    const opened = await pet.evaluate(() => window.mosey.getPresentation());
    const openingPixels = await pixels();
    await expect.poll(pixels, { timeout: 2000 }).not.toBe(openingPixels);
    await closeMenu();
    expect(
      await pet.evaluate(() => window.mosey.getPresentation()),
    ).toMatchObject({
      actionId: opened.actionId,
      startedAt: opened.startedAt,
    });
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
    // The reaction's tail already resembles idle before its done input arrives.
    // Establish completed behavior and paint before comparing across dismissal.
    await expect
      .poll(
        async () =>
          (await current()).posture === "resting" &&
          matchesIdle(await pixels()),
        { interval: 25, timeout: 3000 },
      )
      .toBe(true);
    const afterReaction = await current();
    await closeMenu();
    expect(await current()).toEqual(afterReaction);
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
    await expect
      .poll(async () => (await bounds()).y, { timeout: 3000, interval: 10 })
      .toBeGreaterThan(returning.bounds.y + 3);
    // Window motion advances every 16ms; authored falling frames last 140ms.
    // Observe the new paint independently while the same menu remains open.
    await expect
      .poll(pixels, { timeout: 1000, interval: 5 })
      .not.toBe(returning.pixels);
    await closeMenu();
    // A fresh drop gives the cross-frame input scenario its own falling
    // interval; observing the preceding menu must not consume that interval.
    await expect.poll(() => distanceFromGround(app!)).toBe(0);
    await waitPosture("resting");
    const secondGround = await bounds();
    await pet.mouse.move(120, 180);
    await pet.mouse.down();
    await pet.mouse.move(120, -120, { steps: 4 });
    await expect
      .poll(async () => (await bounds()).y)
      .toBeLessThan(secondGround.y - 200);
    await pet.mouse.up();
    await waitPosture("falling");
    const fallingPresentation = await current();
    expect(fallingPresentation.posture).toBe("falling");
    await geometry.waitForPaint(fallingPresentation);
    // Select a painted falling body, then deliver the same target after the
    // next real paint. No motion or animation clocks are slowed for this check.
    await openMenu(false, async () => {
      const selectedFrame = await pixels();
      await expect
        .poll(pixels, { timeout: 1000, interval: 5 })
        .not.toBe(selectedFrame);
    });
    // The baseline belongs to popup delivery, before later driver round trips
    // can use up the remaining fall. Opening after landing is still a failure.
    const falling = await app.evaluate(() =>
      Reflect.get(Reflect.get(globalThis, "menus").at(-1), "testOpened"),
    );
    expect(falling.bounds.y).toBeLessThan(falling.ground);
    await expect
      .poll(async () => (await bounds()).y, { interval: 10 })
      .toBeGreaterThan(falling.bounds.y);
    await expect
      .poll(() => distanceFromGround(app!), { timeout: 4000, interval: 10 })
      .toBe(0);
    await waitPosture("landing");
    const landing = await pixels();
    const landingBounds = await bounds();
    await waitPosture("resting");
    await expect.poll(pixels, { timeout: 1000, interval: 5 }).not.toBe(landing);
    expect(await bounds()).toEqual(landingBounds);
    const landed = await current();
    await closeMenu();
    expect(await current()).toEqual(landed);
    await expect.poll(async () => matchesIdle(await pixels())).toBe(true);
    // Deadlines and movement continue under an open menu, through the next walk.
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
    await expect
      .poll(async () => Math.abs((await bounds()).x - walking.bounds.x), {
        interval: 20,
      })
      .toBeGreaterThan(30);
    await waitPosture("resting");
    await waitPosture("walking");
    await expect
      .poll(pixels, { timeout: 1000, interval: 5 })
      .not.toBe(walking.pixels);
    // Walking continues between driver calls. Observe the synchronous menu
    // resize itself so normal movement is not counted as a resize jump.
    const resized = await app.evaluate(({ BrowserWindow }) => {
      const pet = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Mosey",
      )!;
      const before = pet.getBounds();
      Reflect.get(globalThis, "menus")
        .at(-1)
        .items.find((item: { label: string }) => item.label === "Pet Size")
        .submenu.items.find(
          (item: { label: string }) => item.label === "Medium",
        )
        .click();
      return { before, after: pet.getBounds() };
    });
    expect(resized.after).toMatchObject({ width: 160, height: 160 });
    expect(resized.after.x + resized.after.width / 2).toBe(
      resized.before.x + resized.before.width / 2,
    );
    expect(resized.after.y + resized.after.height).toBe(
      resized.before.y + resized.before.height,
    );
    await closeMenu();
    const justResumed = await bounds();
    expect(justResumed.width).toBe(160);
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
    // native/menu behavior stay in charge of every subsequent assertion.
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
      await app.evaluate((_electron, choice) => {
        Math.random = () => choice;
      }, choice);
      await invoke("Hide Mosey");
      await invoke("Show Mosey");
      const expectedLabel = choice === 0.6 ? "柯基 · 伸展" : "柯基 · 玩耍";
      const started = performance.now();
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
      await waitPosture("resting");
      await expect
        .poll(pixels, { timeout: 1000, interval: 5 })
        .not.toBe(activity.pixels);
      expect(await bounds()).toEqual(activity.bounds);
      const finished = await current();
      expect(finished.posture).toBe("resting");
      await closeMenu();
      expect(await current()).toEqual(finished);
      await expect
        .poll(async () => matchesIdle(await pixels()), {
          timeout: 3000,
          interval: 25,
        })
        .toBe(true);
    }
    await pet.evaluate(() => Reflect.get(window, "restoreMenuFrames")());
    await app.evaluate(() => {
      globalThis.setTimeout = Reflect.get(globalThis, "unshortenedTimeout");
    });
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
      // callback. Explicit lifecycle cancellation must still release input.
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
        await readFile(path.join(session.profile, "preferences.json"), "utf8"),
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
    session.mark("quit-from-native-menu");
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
    app = (await session.restart()).app;
    session.mark("persisted-size-after-relaunch");
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

    await writeFile(
      evidencePath(`${packaged ? "packaged" : "development"}-menu.json`),
      JSON.stringify(
        {
          nativeMenu:
            "actual first show/items/cancel; subsequent tracking boundary intercepted",
          inputs:
            "Playwright targeted right-click and Control-click; native Menu public API used for cancel/select",
          continued: [
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
    await app
      ?.windows()[0]
      ?.screenshot({
        path: evidencePath(
          `failure-${packaged ? "packaged" : "development"}-menu.png`,
        ),
        timeout: 3000,
      })
      .catch(() => {});
    throw error;
  } finally {
    await session.close();
  }
});
