import { test, expect } from "vitest";
import { rm, readFile, mkdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { openSettings, closeSettings } from "./support/settings";
import { createPetTestSession } from "./support/pet-session";
test("slider previews without saving, commits on release, and persists nonpreset sizes", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      size: 160,
      visibility: "visible",
    },
  });
  let { app } = await session.launch();
  const traceFile = path.join(session.evidence, "slider-trace.jsonl");
  // Diagnostic event recording remains available during cleanup. It never
  // initiates another scenario action or queries a failed driver.
  app.on("window", (page) =>
    page.on("console", (message) => {
      const prefix = "__moseySliderTrace__";
      if (message.type() === "debug" && message.text().startsWith(prefix))
        appendFileSync(
          traceFile,
          JSON.stringify({
            source: "renderer",
            ...JSON.parse(message.text().slice(prefix.length)),
          }) + "\n",
        );
    }),
  );
  await session.run("slider:app.evaluate", () =>
    app.evaluate(({ app }, traceFile) => {
      Reflect.set(globalThis, "sliderNativeTrace", []);
      app.on("browser-window-created", (_event, window) => {
        const record = (type: string) => {
          if (window.isDestroyed()) return;
          const events = Reflect.get(globalThis, "sliderNativeTrace");
          const event = {
            source: "native",
            type,
            at: Date.now(),
            visible: window.isVisible(),
            focused: window.isFocused(),
            title: window.getTitle(),
            bounds: window.getBounds(),
          };
          events.push(event);
          process
            .getBuiltinModule("node:fs")
            .appendFileSync(traceFile, JSON.stringify(event) + "\n");
          if (events.length > 50) events.shift();
        };
        record("created");
        window.on("ready-to-show", () => record("ready-to-show"));
        window.on("show", () => record("show"));
        window.on("focus", () => record("focus"));
        window.on("blur", () => record("blur"));
        window.on("hide", () => record("hide"));
      });
    }, traceFile),
  );
  await session.run("slider:app.addInitScript", () =>
    app.context().addInitScript(() => {
      const observer = new MutationObserver(() => {
        const input = document.querySelector<HTMLInputElement>(
          'input[type="range"]',
        );
        if (!input) return;
        observer.disconnect();
        const events: unknown[] = [];
        Reflect.set(window, "sliderTrace", events);
        const record = (type: string, event?: Event) => {
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
          console.debug("__moseySliderTrace__" + JSON.stringify(events.at(-1)));
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
    }),
  );
  const settings = await openSettings(app, { run: session.run });
  const slider = settings.getByRole("slider", { name: "宠物大小" });
  await session.run("slider:slider.waitFor", () =>
    slider.waitFor({ timeout: 5000 }),
  );
  expect(
    await session.run("slider:slider.getAttribute", () =>
      slider.getAttribute("min"),
    ),
  ).toBe("70");
  expect(
    await session.run("slider:slider.getAttribute", () =>
      slider.getAttribute("max"),
    ),
  ).toBe("240");
  expect(
    await session.run("slider:slider.getAttribute", () =>
      slider.getAttribute("step"),
    ),
  ).toBe("10");
  const side = () =>
    session.run("slider:app.evaluate", () =>
      app!.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.getTitle() === "Mosey")!
            .getBounds().width,
      ),
    );
  const file = path.join(session.profile, "preferences.json");
  // Grab the current thumb. The midpoint is track at size160 in range70–240.
  const thumbFraction = () =>
    session.run("slider:slider.evaluate", () =>
      slider.evaluate(
        (input: HTMLInputElement) =>
          (Number(input.value) - Number(input.min)) /
          (Number(input.max) - Number(input.min)),
      ),
    );
  // This acceptance directs CDP input; physical mouse/OS routing is a separate
  // desktop check. Native range capture receives global OS movement even when
  // the cursor is outside, so exclude it only while the synthetic drag is held.
  const isolateNativePointer = (ignore: boolean) =>
    session.run("slider:app.evaluate", () =>
      app!.evaluate(({ BrowserWindow }, ignore) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Mosey 设置")
          ?.setIgnoreMouseEvents(ignore);
      }, ignore),
    );
  await isolateNativePointer(true);
  const bounds = (await session.run("slider:slider.boundingBox", () =>
    slider.boundingBox(),
  ))!;
  const initialThumb = await thumbFraction();
  await session.run("slider:settings.move", () =>
    settings.mouse.move(
      bounds.x + bounds.width * initialThumb,
      bounds.y + bounds.height / 2,
    ),
  );
  await session.run("slider:settings.down", () => settings.mouse.down());
  await session.run("slider:settings.move", () =>
    settings.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2, {
      steps: 4,
    }),
  );
  await expect.poll(side).toBe(70);
  expect(
    JSON.parse(
      await session.run("slider:readFile", () => readFile(file, "utf8")),
    ).size,
  ).toBe(160);
  await session.run("slider:settings.up", () => settings.mouse.up());
  await isolateNativePointer(false);
  await expect
    .poll(
      async () =>
        JSON.parse(
          await session.run("slider:readFile", () => readFile(file, "utf8")),
        ).size,
    )
    .toBe(70);
  await session.run("slider:slider.focus", () => slider.focus());
  await session.run("slider:settings.press", () =>
    settings.keyboard.press("ArrowRight"),
  );
  await expect.poll(side).toBe(80);
  await expect
    .poll(
      async () =>
        JSON.parse(
          await session.run("slider:readFile", () => readFile(file, "utf8")),
        ).size,
    )
    .toBe(80);
  expect(
    await session.run("slider:settings.count", () =>
      settings.locator('[aria-pressed="true"]').count(),
    ),
  ).toBe(0);
  // A keyboard adjustment commits on blur even before the inactivity timer.
  await session.run("slider:settings.down", () =>
    settings.keyboard.down("ArrowRight"),
  );
  await session.run("slider:settings.press", () =>
    settings.keyboard.press("Tab"),
  );
  await session.run("slider:settings.up", () =>
    settings.keyboard.up("ArrowRight"),
  );
  await expect
    .poll(
      async () =>
        JSON.parse(
          await session.run("slider:readFile", () => readFile(file, "utf8")),
        ).size,
    )
    .toBe(90);
  await session.run("slider:slider.focus", () => slider.focus());
  // Storage faults are injected at the filesystem boundary; the UI and pet
  // must both roll back and retry the failed target rather than that rollback.
  await session.run("slider:rm", () => rm(file));
  await session.run("slider:mkdir", () => mkdir(file));
  await session.run("slider:settings.press", () =>
    settings.keyboard.press("End"),
  );
  await expect
    .poll(() =>
      session.run("slider:settings.isVisible", () =>
        settings.getByRole("alert").isVisible(),
      ),
    )
    .toBe(true);
  expect(await side()).toBe(90);
  expect(
    await session.run("slider:slider.inputValue", () => slider.inputValue()),
  ).toBe("90");
  await session.run("slider:rm", () => rm(file, { recursive: true }));
  await session.run("slider:settings.click", () =>
    settings.getByRole("button", { name: "重试", exact: true }).click(),
  );
  await expect.poll(side).toBe(240);
  await expect
    .poll(
      async () =>
        JSON.parse(
          await session.run("slider:readFile", () => readFile(file, "utf8")),
        ).size,
    )
    .toBe(240);
  // An older failed operation must not restore its target over a new choice.
  await session.run("slider:mkdir", () => mkdir(file + ".tmp"));
  await session.run("slider:settings.evaluate", () =>
    settings.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-size="70"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-size="160"]')!.click();
    }),
  );
  await expect
    .poll(() =>
      session.run("slider:settings.isVisible", () =>
        settings.getByRole("alert").isVisible(),
      ),
    )
    .toBe(true);
  await session.run("slider:rm", () => rm(file + ".tmp", { recursive: true }));
  await session.run("slider:settings.click", () =>
    settings.getByRole("button", { name: "中（默认）" }).click(),
  );
  await expect.poll(side).toBe(160);
  await expect
    .poll(() =>
      session.run("slider:settings.isVisible", () =>
        settings.getByRole("alert").isVisible(),
      ),
    )
    .toBe(false);
  await session.run("slider:app.evaluate", () =>
    app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items.find((item) => item.label === "Mosey")!
        .submenu!.items.find((item) => item.label === "Hide Mosey")!
        .click(),
    ),
  );
  await expect
    .poll(() =>
      session.run("slider:settings.isVisible", () =>
        settings.getByText("宠物已隐藏").isVisible(),
      ),
    )
    .toBe(true);
  // Close while a pointer preview is uncommitted. The main process owns the
  // final commit, so renderer teardown cannot drop it.
  await session.run("slider:slider.scrollIntoViewIfNeeded", () =>
    slider.scrollIntoViewIfNeeded(),
  );
  await isolateNativePointer(true);
  const closingBounds = (await session.run("slider:slider.boundingBox", () =>
    slider.boundingBox(),
  ))!;
  const closingThumb = await thumbFraction();
  await session.run("slider:settings.move", () =>
    settings.mouse.move(
      closingBounds.x + closingBounds.width * closingThumb,
      closingBounds.y + closingBounds.height / 2,
    ),
  );
  await session.run("slider:settings.down", () => settings.mouse.down());
  await session.run("slider:settings.move", () =>
    settings.mouse.move(
      closingBounds.x + 8,
      closingBounds.y + closingBounds.height / 2,
    ),
  );
  await expect.poll(side).toBe(70);
  expect(
    JSON.parse(
      await session.run("slider:readFile", () => readFile(file, "utf8")),
    ).size,
  ).toBe(160);
  await closeSettings(app, { run: session.run });
  await expect
    .poll(
      async () =>
        JSON.parse(
          await session.run("slider:readFile", () => readFile(file, "utf8")),
        ).size,
    )
    .toBe(70);
  await session.quit();
  ({ app } = await session.launch());
  expect(await side()).toBe(70);
  expect(
    await session.run("slider:app.evaluate", () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .isVisible(),
      ),
    ),
  ).toBe(false);
  await session.quit();
});
