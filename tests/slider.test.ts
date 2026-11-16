import { onMainLoop } from "./support/main-loop";
import { evidencePath } from "./support/evidence";
import { test, expect, onTestFinished } from "vitest";
import { createElectronFixtureCleanup } from "./support/electron-fixture-cleanup";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { startForge } from "./support/forge";
import { openSettings } from "./support/settings";
import { describeSyntheticDragInterference } from "./support/synthetic-drag-interference";
import {
  afterMainLoopTurn,
  recordResponsiveness,
} from "./support/responsiveness-evidence";
const packaged = process.env.MOSEY_TEST_MODE === "packaged";
const scaleFactor = Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1");
const scaleArgument = `--force-device-scale-factor=${scaleFactor}`;
test("slider previews without saving, commits on release, and persists nonpreset sizes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-slider-"));
  const profile = path.join(root, "profile");
  let app: ElectronApplication | undefined;
  let stop: (() => Promise<void>) | undefined;
  let failure: { error: unknown } | undefined;
  let holding = false;
  const fixture = createElectronFixtureCleanup(
    [
      async () => {
        await stop?.();
      },
      () => rm(root, { recursive: true, force: true }),
    ],
    async () => {
      await Promise.all([
        ...(app?.windows() ?? []).map((page) => page.mouse.up()),
        app?.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey 设置")
            ?.setIgnoreMouseEvents(false);
        }),
      ]);
    },
  );
  onTestFinished(() => fixture.cleanup(failure));
  let prepared = false;
  try {
    await mkdir(profile, { recursive: true });
    await writeFile(
      path.join(profile, "preferences.json"),
      JSON.stringify({
        version: 3,
        character: "corgi",
        size: 160,
        visibility: "visible",
      }),
    );
    const launch = () =>
      fixture.launch(async () => {
        if (!prepared) {
          if (!packaged) stop = await startForge();
          else
            execFileSync(
              "/usr/bin/ditto",
              [
                path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
                path.join(root, "Mosey.app"),
              ],
              { timeout: 30000 },
            );
          prepared = true;
        }
        return electron.launch(
          packaged
            ? {
                timeout: 30000,
                executablePath: path.join(
                  root,
                  "Mosey.app/Contents/MacOS/Mosey",
                ),
                args: [
                  scaleArgument,
                  "-ApplePersistenceIgnoreState",
                  "YES",
                  `--user-data-dir=${profile}`,
                ],
              }
            : {
                args: [
                  ".",
                  scaleArgument,
                  "-ApplePersistenceIgnoreState",
                  "YES",
                  `--user-data-dir=${profile}`,
                ],
                timeout: 30000,
              },
        );
      });
    app = await launch();
    expect(
      await (await app.firstWindow()).evaluate(() => devicePixelRatio),
    ).toBe(scaleFactor);
    await app.evaluate(({ app }) => {
      Reflect.set(globalThis, "sliderNativeTrace", []);
      app.on("browser-window-created", (_event, window) => {
        const record = (type: string) => {
          if (window.isDestroyed()) return;
          const events = Reflect.get(globalThis, "sliderNativeTrace");
          events.push({
            type,
            at: Date.now(),
            visible: window.isVisible(),
            focused: window.isFocused(),
          });
          if (events.length > 50) events.shift();
        };
        record("created");
        window.on("ready-to-show", () => record("ready-to-show"));
        window.on("show", () => record("show"));
        window.on("focus", () => record("focus"));
        window.on("blur", () => record("blur"));
        window.on("hide", () => record("hide"));
      });
    });
    await app.context().addInitScript(() => {
      const observer = new MutationObserver(() => {
        const input = document.querySelector<HTMLInputElement>(
          'input[type="range"]',
        );
        if (!input) return;
        observer.disconnect();
        const events: unknown[] = [];
        Reflect.set(window, "sliderTrace", events);
        // Kept apart from the rolling trace: OS movement can flood it with
        // later events after it ends the held drag.
        const held: unknown[] = [];
        Reflect.set(window, "sliderHeldPointer", held);
        const record = (type: string, event?: Event) => {
          if (
            Reflect.get(window, "sliderSyntheticHold") &&
            event instanceof PointerEvent &&
            ["pointerdown", "pointermove", "pointerup"].includes(type) &&
            held.length < 50
          )
            // Shape of PointerEventDuringHold; evaluated code cannot import it.
            held.push({
              type,
              at: Date.now(),
              buttons: event.buttons,
              screenX: event.screenX,
              screenY: event.screenY,
            });
          const rect = input.getBoundingClientRect();
          events.push({
            type,
            at: performance.now(),
            wall: Date.now(),
            value: input.value,
            active: document.activeElement === input,
            focused: document.hasFocus(),
            x: event && Reflect.get(event, "clientX"),
            y: event && Reflect.get(event, "clientY"),
            buttons: event && Reflect.get(event, "buttons"),
            pointerId: event && Reflect.get(event, "pointerId"),
            capture:
              event && Reflect.has(event, "pointerId")
                ? input.hasPointerCapture(Reflect.get(event, "pointerId"))
                : undefined,
            screenX: event && Reflect.get(event, "screenX"),
            screenY: event && Reflect.get(event, "screenY"),
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          });
          if (events.length > 150) events.shift();
        };
        for (const type of [
          "pointerdown",
          "pointermove",
          "pointerup",
          "pointercancel",
          "gotpointercapture",
          "lostpointercapture",
          "input",
          "change",
          "blur",
          "focus",
        ])
          window.addEventListener(type, (event) => record(type, event), true);
        window.moseySettings.onChange((next) =>
          record("settings-update " + next.size),
        );
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    const settings = await openSettings(app);
    const slider = settings.getByRole("slider", { name: "宠物大小" });
    await slider.waitFor({ timeout: 5000 });
    expect(await slider.getAttribute("min")).toBe("70");
    expect(await slider.getAttribute("max")).toBe("240");
    expect(await slider.getAttribute("step")).toBe("10");
    const side = () =>
      app!.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.getTitle() === "Mosey")!
            .getBounds().width,
      );
    const file = path.join(profile, "preferences.json");
    // Grab the current thumb. The midpoint is track at size160 in range70–240.
    const thumbFraction = () =>
      slider.evaluate(
        (input: HTMLInputElement) =>
          (Number(input.value) - Number(input.min)) /
          (Number(input.max) - Number(input.min)),
      );
    // This acceptance directs CDP input; physical mouse/OS routing is a separate
    // desktop check. Ignoring mouse events excludes OS movement outside the
    // settings window while the synthetic drag is held. It does not exclude
    // movement over the window: the OS reports its unpressed button, which ends
    // the drag. A failure during such a hold is reported as interference.
    const isolateNativePointer = (ignore: boolean) =>
      app!.evaluate(({ BrowserWindow }, ignore) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Mosey 设置")
          ?.setIgnoreMouseEvents(ignore);
      }, ignore);
    // Bounds the interval in which every pointer event must report the button
    // held by the directed drag. Each hold observes only its own events.
    const holdSyntheticDrag = async (hold: boolean) => {
      await settings.evaluate((hold) => {
        if (hold) Reflect.get(window, "sliderHeldPointer")?.splice(0);
        Reflect.set(window, "sliderSyntheticHold", hold);
      }, hold);
      holding = hold;
    };
    await isolateNativePointer(true);
    const bounds = (await slider.boundingBox())!;
    await settings.mouse.move(
      bounds.x + bounds.width * (await thumbFraction()),
      bounds.y + bounds.height / 2,
    );
    await holdSyntheticDrag(true);
    await settings.mouse.down();
    await settings.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2, {
      steps: 4,
    });
    await expect.poll(side).toBe(70);
    expect(JSON.parse(await readFile(file, "utf8")).size).toBe(160);
    await holdSyntheticDrag(false);
    await settings.mouse.up();
    await isolateNativePointer(false);
    await expect
      .poll(async () => JSON.parse(await readFile(file, "utf8")).size)
      .toBe(70);
    await slider.focus();
    await settings.keyboard.press("ArrowRight");
    await expect.poll(side).toBe(80);
    await expect
      .poll(async () => JSON.parse(await readFile(file, "utf8")).size)
      .toBe(80);
    expect(await settings.locator('[aria-pressed="true"]').count()).toBe(0);
    // A keyboard adjustment commits on blur even before the inactivity timer.
    await settings.keyboard.down("ArrowRight");
    await settings.keyboard.press("Tab");
    await settings.keyboard.up("ArrowRight");
    await expect
      .poll(async () => JSON.parse(await readFile(file, "utf8")).size)
      .toBe(90);
    await slider.focus();
    // Storage faults are injected at the filesystem boundary; the UI and pet
    // must both roll back and retry the failed target rather than that rollback.
    await rm(file);
    await mkdir(file);
    await settings.keyboard.press("End");
    await expect.poll(() => settings.getByRole("alert").isVisible()).toBe(true);
    expect(await side()).toBe(90);
    expect(await slider.inputValue()).toBe("90");
    await rm(file, { recursive: true });
    await settings.getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(side).toBe(240);
    await expect
      .poll(async () => JSON.parse(await readFile(file, "utf8")).size)
      .toBe(240);
    // An older failed operation must not restore its target over a new choice.
    await mkdir(file + ".tmp");
    await settings.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-size="70"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-size="160"]')!.click();
    });
    await expect.poll(() => settings.getByRole("alert").isVisible()).toBe(true);
    await rm(file + ".tmp", { recursive: true });
    await settings.getByRole("button", { name: "中（默认）" }).click();
    await expect.poll(side).toBe(160);
    await expect
      .poll(() => settings.getByRole("alert").isVisible())
      .toBe(false);
    await onMainLoop(app, ({ Menu }) =>
      Menu.getApplicationMenu()!
        .items.find((item) => item.label === "Mosey")!
        .submenu!.items.find((item) => item.label === "Hide Mosey")!
        .click(),
    );
    await expect
      .poll(() => settings.getByText("宠物已隐藏").isVisible())
      .toBe(true);
    // Close while a pointer preview is uncommitted. The main process owns the
    // final commit, so renderer teardown cannot drop it.
    await slider.scrollIntoViewIfNeeded();
    await isolateNativePointer(true);
    const closingBounds = (await slider.boundingBox())!;
    await settings.mouse.move(
      closingBounds.x + closingBounds.width * (await thumbFraction()),
      closingBounds.y + closingBounds.height / 2,
    );
    await holdSyntheticDrag(true);
    await settings.mouse.down();
    await settings.mouse.move(
      closingBounds.x + 8,
      closingBounds.y + closingBounds.height / 2,
    );
    await expect.poll(side).toBe(70);
    expect(JSON.parse(await readFile(file, "utf8")).size).toBe(160);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Mosey 设置")!
        .close(),
    );
    // The held drag ends with the window it belonged to.
    holding = false;
    await expect
      .poll(async () => JSON.parse(await readFile(file, "utf8")).size)
      .toBe(70);
    await fixture.closeApp();
    app = await launch();
    expect(
      await (await app.firstWindow()).evaluate(() => devicePixelRatio),
    ).toBe(scaleFactor);
    expect(await side()).toBe(70);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .isVisible(),
      ),
    ).toBe(false);
  } catch (error) {
    failure = { error };
    // Only a failure inside a held drag, and only input before it, can be
    // attributed to OS movement; later steps and later movement cannot.
    const failedAt = Date.now();
    const failedWhileHeld = holding;
    const evidence = `failure-${packaged ? "packaged" : "development"}-slider`;
    const running = app;
    const pages = running?.windows() ?? [];
    const settings = pages.find((page) =>
      new URL(page.url()).searchParams.has("settings"),
    );
    const pet = pages.find(
      (page) => !new URL(page.url()).searchParams.has("settings"),
    );
    // Hide Mosey is dispatched from inspector evaluation before a renderer poll.
    const { renderers } = await recordResponsiveness({
      name: evidence,
      evidenceDirectory: evidencePath(),
      main: {
        pid: running?.process().pid,
        probe:
          running &&
          afterMainLoopTurn(running, () =>
            running.evaluate(({ BrowserWindow }) => ({
              events: Reflect.get(globalThis, "sliderNativeTrace"),
              windows: BrowserWindow.getAllWindows().map((window) => ({
                title: window.getTitle(),
                bounds: window.getBounds(),
                visible: window.isVisible(),
                focused: window.isFocused(),
              })),
            })),
          ),
      },
      renderers: {
        settings:
          settings &&
          (() =>
            settings.evaluate(async () => ({
              events: Reflect.get(window, "sliderTrace"),
              held: Reflect.get(window, "sliderHeldPointer"),
              settings: await window.moseySettings.get(),
            }))),
        pet: pet && (() => pet.evaluate(() => document.readyState)),
      },
    });
    const held = renderers.settings.value?.held;
    const interference =
      failedWhileHeld && Array.isArray(held)
        ? describeSyntheticDragInterference(
            held.filter((event: { at: number }) => event.at <= failedAt),
          )
        : undefined;
    if (interference)
      failure = { error: new Error(interference, { cause: error }) };
    for (const page of app?.windows() ?? []) {
      const name = new URL(page.url()).searchParams.has("settings")
        ? "settings"
        : "pet";
      await page
        .screenshot({
          path: evidencePath(`${evidence}-${name}.png`),
          timeout: 3000,
        })
        .catch(() => {});
    }
    throw failure.error;
  } finally {
    await fixture.cleanup(failure);
  }
});
