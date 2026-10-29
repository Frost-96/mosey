import { test, expect } from "vitest";
import { mkdir } from "node:fs/promises";
import { closeSettings, openSettings } from "./support/settings";
import { createPetTestSession } from "./support/pet-session";
import type { Settings } from "../src/shared/contract";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("settings protects edits while independently merging IPC results and notifications", async () => {
  const session = await createPetTestSession({ dock: "empty" });
  const { app } = await session.launch();
  const original = await openSettings(app, { run: session.run });
  await closeSettings(app, { run: session.run });
  const initial: Settings = {
    revision: 1000,
    character: "corgi",
    size: 160,
    visibility: "visible",
    login: { status: "disabled" },
  };
  // Control only the IPC boundary: the page, React lifecycle and sandboxed
  // preload remain real. Held responses model transport reordering.
  await session.run("settings-state:app.evaluate", () =>
    app.evaluate(({ app, ipcMain, BrowserWindow }, initial) => {
      // Isolate outgoing IPC notifications too, so native focus timing cannot
      // race the deliberately failed/held initial reads below.
      app.on("browser-window-created", (_event, window) => {
        const send = window.webContents.send.bind(window.webContents);
        Reflect.set(
          window.webContents,
          "notifySettingsTest",
          (next: typeof initial) => send("settings:state", next),
        );
        window.webContents.send = (channel, ...args) => {
          if (channel !== "settings:state") send(channel, ...args);
        };
      });
      const calls: { channel: string; value: unknown }[] = [];
      const pending: {
        channel: string;
        resolve: (value: typeof initial) => void;
        reject: (error: Error) => void;
      }[] = [];
      for (const channel of [
        "settings:get",
        "settings:preview-size",
        "settings:size",
        "settings:login-launch",
        "settings:character",
      ]) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event, value: unknown) => {
          calls.push({ channel, value });
          return new Promise((resolve, reject) =>
            pending.push({ channel, resolve, reject }),
          );
        });
      }
      Reflect.set(globalThis, "settingsCalls", calls);
      Reflect.set(
        globalThis,
        "finishSettingsCall",
        (args: {
          channel: string;
          result?: typeof initial;
          reject?: boolean;
          last?: boolean;
        }) => {
          const match = (call: { channel: string }) =>
            call.channel === args.channel;
          const index = args.last
            ? pending.findLastIndex(match)
            : pending.findIndex(match);
          if (index < 0) throw new Error(`No pending ${args.channel}`);
          const [call] = pending.splice(index, 1);
          if (args.reject)
            call.reject(new Error("controlled transport failure"));
          else call.resolve(args.result ?? initial);
        },
      );
      Reflect.set(globalThis, "notifySettings", (next: typeof initial) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.getTitle() === "Mosey 设置",
        )!;
        Reflect.get(window.webContents, "notifySettingsTest")(next);
      });
    }, initial),
  );
  const settings = await openSettings(app, {
    run: session.run,
    waitForInitialState: false,
  });
  expect(original.isClosed()).toBe(true);
  const notify = (next: Settings) =>
    session.run("settings-state:app.evaluate", () =>
      app!.evaluate(
        (_, next) => Reflect.get(globalThis, "notifySettings")(next),
        next,
      ),
    );
  const finish = (
    channel: string,
    result: Settings,
    reject = false,
    last = false,
  ) =>
    session.run("settings-state:app.evaluate", () =>
      app!.evaluate(
        (_, args) => Reflect.get(globalThis, "finishSettingsCall")(args),
        {
          channel,
          result,
          reject,
          last,
        },
      ),
    );
  const count = (channel: string) =>
    session.run("settings-state:app.evaluate", () =>
      app!.evaluate(
        (_, channel) =>
          Reflect.get(globalThis, "settingsCalls").filter(
            (call: { channel: string }) => call.channel === channel,
          ).length,
        channel,
      ),
    );
  await notify(initial);
  const slider = settings.getByRole("slider", { name: "宠物大小" });
  await expect
    .poll(() =>
      session.run("settings-state:slider.inputValue", () =>
        slider.inputValue(),
      ),
    )
    .toBe("160");
  await session.run("settings-state:slider.dispatchEvent", () =>
    slider.dispatchEvent("pointerdown"),
  );
  await session.run("settings-state:slider.evaluate", () =>
    slider.evaluate((element: HTMLInputElement) => {
      element.value = "210";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }),
  );
  // Display the edit immediately, even before its preview IPC completes.
  await expect
    .poll(() =>
      session.run("settings-state:settings.textContent", () =>
        settings.locator("output").textContent(),
      ),
    )
    .toBe("210");
  await notify({
    ...initial,
    revision: 1002,
    visibility: "hidden",
    login: { status: "enabled" },
  });
  expect(
    await session.run("settings-state:slider.inputValue", () =>
      slider.inputValue(),
    ),
  ).toBe("210");
  expect(
    await session.run("settings-state:settings.textContent", () =>
      settings.locator("output").textContent(),
    ),
  ).toBe("210");
  expect(
    await session.run("settings-state:settings.isVisible", () =>
      settings.getByText("宠物已隐藏").isVisible(),
    ),
  ).toBe(true);
  expect(
    await session.run("settings-state:settings.isChecked", () =>
      settings.getByRole("checkbox").isChecked(),
    ),
  ).toBe(true);
  await session.run("settings-state:slider.dispatchEvent", () =>
    slider.dispatchEvent("pointercancel"),
  );
  await expect.poll(() => count("settings:size")).toBe(1);
  await finish("settings:size", { ...initial, revision: 1004, size: 210 });
  await finish("settings:preview-size", {
    ...initial,
    revision: 1001,
    size: 210,
  });
  expect(
    await session.run("settings-state:settings.isChecked", () =>
      settings.getByRole("checkbox").isChecked(),
    ),
  ).toBe(true);
  expect(
    await session.run("settings-state:settings.isVisible", () =>
      settings.getByText("宠物已隐藏").isVisible(),
    ),
  ).toBe(true);
  await expect
    .poll(() =>
      session.run("settings-state:settings.textContent", () =>
        settings.locator("output").textContent(),
      ),
    )
    .toBe("210");
  // A size response cannot overwrite login/visibility, even if its full
  // snapshot carries a higher revision. A login response likewise owns no size.
  await session.run("settings-state:settings.click", () =>
    settings.getByRole("checkbox").click(),
  );
  await session.run("settings-state:settings.click", () =>
    settings.getByRole("button", { name: "小", exact: true }).click(),
  );
  await session.run("settings-state:settings.click", () =>
    settings.getByRole("button", { name: "大", exact: true }).click(),
  );
  await expect.poll(() => count("settings:size")).toBe(3);
  await finish(
    "settings:size",
    { ...initial, revision: 1006, size: 240 },
    false,
    true,
  );
  await finish("settings:size", { ...initial, revision: 1005, size: 70 });
  await expect
    .poll(() =>
      session.run("settings-state:settings.textContent", () =>
        settings.locator("output").textContent(),
      ),
    )
    .toBe("240");
  await finish("settings:login-launch", { ...initial, revision: 1007 });
  await expect
    .poll(() =>
      session.run("settings-state:settings.isEnabled", () =>
        settings.getByRole("checkbox").isEnabled(),
      ),
    )
    .toBe(true);
  expect(
    await session.run("settings-state:slider.inputValue", () =>
      slider.inputValue(),
    ),
  ).toBe("240");
  expect(
    await session.run("settings-state:settings.isVisible", () =>
      settings.getByText("宠物已隐藏").isVisible(),
    ),
  ).toBe(true);
  // Old initial reads must not undo edits or later notifications.
  const reads = await count("settings:get");
  for (let i = 0; i < reads; i++) await finish("settings:get", initial);
  expect(
    await session.run("settings-state:slider.inputValue", () =>
      slider.inputValue(),
    ),
  ).toBe("240");
  // A rejected IPC gives no evidence about durable storage. Keep the target
  // for retry and keep explaining uncertainty across unrelated notifications.
  await session.run("settings-state:settings.click", () =>
    settings.getByRole("button", { name: "小", exact: true }).click(),
  );
  await finish("settings:size", initial, true);
  await expect
    .poll(() =>
      session.run("settings-state:settings.textContent", () =>
        settings.locator(".error").textContent(),
      ),
    )
    .toContain("无法确认保存结果");
  await notify({
    ...initial,
    revision: 1008,
    size: 240,
    visibility: "hidden",
  });
  expect(
    await session.run("settings-state:settings.textContent", () =>
      settings.locator(".error").textContent(),
    ),
  ).toContain("无法确认保存结果");
  await session.run("settings-state:mkdir", () =>
    mkdir("test-results", { recursive: true }),
  );
  await session.run("settings-state:settings.screenshot", () =>
    settings.screenshot({
      fullPage: true,
      path: `test-results/settings-state-${packaged ? "packaged" : "development"}-transport-error.png`,
    }),
  );
  await session.run("settings-state:settings.click", () =>
    settings.getByRole("button", { name: "重试", exact: true }).click(),
  );
  await expect.poll(() => count("settings:size")).toBe(5);
  expect(
    await session.run("settings-state:app.evaluate", () =>
      app.evaluate(() => Reflect.get(globalThis, "settingsCalls").at(-1).value),
    ),
  ).toBe(70);
  await finish("settings:size", { ...initial, revision: 1009, size: 70 });
  await expect
    .poll(() =>
      session.run("settings-state:slider.inputValue", () =>
        slider.inputValue(),
      ),
    )
    .toBe("70");
  expect(
    await session.run("settings-state:settings.isVisible", () =>
      settings.locator(".error").isVisible(),
    ),
  ).toBe(false);
  // Boundary events can overlap: cancellation, capture loss, blur and release
  // must commit one edit only. A preset also cancels the keyboard timer.
  const edit = (size: number) =>
    session.run("settings-state:slider.evaluate", () =>
      slider.evaluate((element: HTMLInputElement, size) => {
        element.value = String(size);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }, size),
    );
  await session.run("settings-state:slider.dispatchEvent", () =>
    slider.dispatchEvent("pointerdown"),
  );
  await edit(120);
  await session.run("settings-state:slider.dispatchEvent", () =>
    slider.dispatchEvent("lostpointercapture"),
  );
  await session.run("settings-state:slider.dispatchEvent", () =>
    slider.dispatchEvent("blur"),
  );
  await session.run("settings-state:settings.evaluate", () =>
    settings.evaluate(() => window.dispatchEvent(new Event("pointerup"))),
  );
  await expect.poll(() => count("settings:size")).toBe(6);
  await finish("settings:size", { ...initial, revision: 1010, size: 120 });
  await finish("settings:preview-size", {
    ...initial,
    revision: 1010,
    size: 120,
  });
  await session.run("settings-state:slider.evaluate", () =>
    slider.evaluate((element: HTMLInputElement) => {
      element.value = "130";
      element.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector<HTMLButtonElement>('[data-size="160"]')!.click();
    }),
  );
  await finish("settings:size", { ...initial, revision: 1011 });
  await finish("settings:preview-size", {
    ...initial,
    revision: 1010,
    size: 130,
  });
  await session.run("settings-state:settings.waitForTimeout", () =>
    settings.waitForTimeout(350),
  );
  expect(await count("settings:size")).toBe(7);
  // Retire the entire React tree while a keyboard timer and IPC are pending.
  // Cleanup releases resources and never saves; old callbacks cannot render.
  await edit(140);
  await session.run("settings-state:settings.evaluate", () =>
    settings.evaluate(() => window.dispatchEvent(new Event("pagehide"))),
  );
  await expect
    .poll(() =>
      session.run("settings-state:settings.count", () =>
        settings.locator("main").count(),
      ),
    )
    .toBe(0);
  await finish("settings:preview-size", {
    ...initial,
    revision: 1012,
    size: 140,
  });
  await notify({ ...initial, revision: 1013, size: 140 });
  await session.run("settings-state:settings.evaluate", () =>
    settings.evaluate(() => {
      window.dispatchEvent(new Event("pointerup"));
      window.dispatchEvent(new Event("blur"));
    }),
  );
  await session.run("settings-state:settings.waitForTimeout", () =>
    settings.waitForTimeout(350),
  );
  expect(await count("settings:size")).toBe(7);
  expect(
    await session.run("settings-state:settings.count", () =>
      settings.locator("main").count(),
    ),
  ).toBe(0);
  await closeSettings(app, { run: session.run });
  const reopened = await openSettings(app, {
    run: session.run,
    waitForInitialState: false,
  });
  const newReads = (await count("settings:get")) - reads;
  for (let i = 0; i < newReads; i++)
    await finish("settings:get", initial, true);
  await expect
    .poll(() =>
      session.run("settings-state:reopened.textContent", () =>
        reopened.locator(".error").textContent(),
      ),
    )
    .toContain("无法读取大小设置");
  await notify({ ...initial, revision: 1014, size: 140 });
  await expect
    .poll(() =>
      session.run("settings-state:reopened.textContent", () =>
        reopened.locator("output").textContent(),
      ),
    )
    .toBe("140");
  expect(
    await session.run("settings-state:reopened.isVisible", () =>
      reopened.locator(".error").isVisible(),
    ),
  ).toBe(false);
  await session.run("settings-state:reopened.selectOption", () =>
    reopened.getByRole("combobox").selectOption("whale"),
  );
  await finish("settings:character", initial, true);
  await expect
    .poll(() =>
      session.run("settings-state:reopened.textContent", () =>
        reopened.locator("#character-error").textContent(),
      ),
    )
    .toContain("无法确认角色切换结果");
  await notify({ ...initial, revision: 1015, size: 140, character: "whale" });
  await expect
    .poll(() =>
      session.run("settings-state:reopened.inputValue", () =>
        reopened.getByRole("combobox").inputValue(),
      ),
    )
    .toBe("whale");
  expect(
    await session.run("settings-state:reopened.isVisible", () =>
      reopened.locator("#character-error").isVisible(),
    ),
  ).toBe(false);
  await session.run("settings-state:mkdir", () =>
    mkdir("test-results", { recursive: true }),
  );
  await session.run("settings-state:reopened.screenshot", () =>
    reopened.screenshot({
      fullPage: true,
      path: `test-results/settings-state-${packaged ? "packaged" : "development"}.png`,
    }),
  );
  await session.quit();
});
