import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startForge } from "./support/forge";
import { closeSettings, openSettings } from "./support/settings";
import type { Settings } from "../src/shared/contract";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("settings protects edits while independently merging IPC results and notifications", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-settings-state-"));
  let app: ElectronApplication | undefined;
  let stop: (() => Promise<void>) | undefined;
  try {
    if (!packaged) stop = await startForge();
    else
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [`--user-data-dir=${path.join(root, "profile")}`],
          }
        : { args: [".", `--user-data-dir=${path.join(root, "profile")}`] },
    );
    await app.firstWindow();
    const original = await openSettings(app);
    await closeSettings(app);
    const initial: Settings = {
      revision: 1000,
      character: "corgi",
      size: 160,
      visibility: "visible",
      login: { status: "disabled" },
    };
    // Control only the IPC boundary: the page, React lifecycle and sandboxed
    // preload remain real. Held responses model transport reordering.
    await app.evaluate(({ app, ipcMain, BrowserWindow }, initial) => {
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
    }, initial);
    const settings = await openSettings(app, { waitForInitialState: false });
    expect(original.isClosed()).toBe(true);
    const notify = (next: Settings) =>
      app!.evaluate(
        (_, next) => Reflect.get(globalThis, "notifySettings")(next),
        next,
      );
    const finish = (
      channel: string,
      result: Settings,
      reject = false,
      last = false,
    ) =>
      app!.evaluate(
        (_, args) => Reflect.get(globalThis, "finishSettingsCall")(args),
        {
          channel,
          result,
          reject,
          last,
        },
      );
    const count = (channel: string) =>
      app!.evaluate(
        (_, channel) =>
          Reflect.get(globalThis, "settingsCalls").filter(
            (call: { channel: string }) => call.channel === channel,
          ).length,
        channel,
      );
    await notify(initial);
    const slider = settings.getByRole("slider", { name: "宠物大小" });
    await expect.poll(() => slider.inputValue()).toBe("160");
    await slider.dispatchEvent("pointerdown");
    await slider.evaluate((element: HTMLInputElement) => {
      element.value = "210";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Display the edit immediately, even before its preview IPC completes.
    await expect
      .poll(() => settings.locator("output").textContent())
      .toBe("210");
    await notify({
      ...initial,
      revision: 1002,
      visibility: "hidden",
      login: { status: "enabled" },
    });
    expect(await slider.inputValue()).toBe("210");
    expect(await settings.locator("output").textContent()).toBe("210");
    expect(await settings.getByText("宠物已隐藏").isVisible()).toBe(true);
    expect(await settings.getByRole("checkbox").isChecked()).toBe(true);
    await slider.dispatchEvent("pointercancel");
    await expect.poll(() => count("settings:size")).toBe(1);
    await finish("settings:size", { ...initial, revision: 1004, size: 210 });
    await finish("settings:preview-size", {
      ...initial,
      revision: 1001,
      size: 210,
    });
    expect(await settings.getByRole("checkbox").isChecked()).toBe(true);
    expect(await settings.getByText("宠物已隐藏").isVisible()).toBe(true);
    await expect
      .poll(() => settings.locator("output").textContent())
      .toBe("210");
    // A size response cannot overwrite login/visibility, even if its full
    // snapshot carries a higher revision. A login response likewise owns no size.
    await settings.getByRole("checkbox").click();
    await settings.getByRole("button", { name: "小", exact: true }).click();
    await settings.getByRole("button", { name: "大", exact: true }).click();
    await expect.poll(() => count("settings:size")).toBe(3);
    await finish(
      "settings:size",
      { ...initial, revision: 1006, size: 240 },
      false,
      true,
    );
    await finish("settings:size", { ...initial, revision: 1005, size: 70 });
    await expect
      .poll(() => settings.locator("output").textContent())
      .toBe("240");
    await finish("settings:login-launch", { ...initial, revision: 1007 });
    await expect
      .poll(() => settings.getByRole("checkbox").isEnabled())
      .toBe(true);
    expect(await slider.inputValue()).toBe("240");
    expect(await settings.getByText("宠物已隐藏").isVisible()).toBe(true);
    // Old initial reads must not undo edits or later notifications.
    const reads = await count("settings:get");
    for (let i = 0; i < reads; i++) await finish("settings:get", initial);
    expect(await slider.inputValue()).toBe("240");
    // A rejected IPC gives no evidence about durable storage. Keep the target
    // for retry and keep explaining uncertainty across unrelated notifications.
    await settings.getByRole("button", { name: "小", exact: true }).click();
    await finish("settings:size", initial, true);
    await expect
      .poll(() => settings.locator(".error").textContent())
      .toContain("无法确认保存结果");
    await notify({
      ...initial,
      revision: 1008,
      size: 240,
      visibility: "hidden",
    });
    expect(await settings.locator(".error").textContent()).toContain(
      "无法确认保存结果",
    );
    await mkdir("test-results", { recursive: true });
    await settings.screenshot({
      fullPage: true,
      path: `test-results/settings-state-${packaged ? "packaged" : "development"}-transport-error.png`,
    });
    await settings.getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(() => count("settings:size")).toBe(5);
    expect(
      await app.evaluate(
        () => Reflect.get(globalThis, "settingsCalls").at(-1).value,
      ),
    ).toBe(70);
    await finish("settings:size", { ...initial, revision: 1009, size: 70 });
    await expect.poll(() => slider.inputValue()).toBe("70");
    expect(await settings.locator(".error").isVisible()).toBe(false);
    // Boundary events can overlap: cancellation, capture loss, blur and release
    // must commit one edit only. A preset also cancels the keyboard timer.
    const edit = (size: number) =>
      slider.evaluate((element: HTMLInputElement, size) => {
        element.value = String(size);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }, size);
    await slider.dispatchEvent("pointerdown");
    await edit(120);
    await slider.dispatchEvent("lostpointercapture");
    await slider.dispatchEvent("blur");
    await settings.evaluate(() => window.dispatchEvent(new Event("pointerup")));
    await expect.poll(() => count("settings:size")).toBe(6);
    await finish("settings:size", { ...initial, revision: 1010, size: 120 });
    await finish("settings:preview-size", {
      ...initial,
      revision: 1010,
      size: 120,
    });
    await slider.evaluate((element: HTMLInputElement) => {
      element.value = "130";
      element.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector<HTMLButtonElement>('[data-size="160"]')!.click();
    });
    await finish("settings:size", { ...initial, revision: 1011 });
    await finish("settings:preview-size", {
      ...initial,
      revision: 1010,
      size: 130,
    });
    await settings.waitForTimeout(350);
    expect(await count("settings:size")).toBe(7);
    // Retire the entire React tree while a keyboard timer and IPC are pending.
    // Cleanup releases resources and never saves; old callbacks cannot render.
    await edit(140);
    await settings.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect.poll(() => settings.locator("main").count()).toBe(0);
    await finish("settings:preview-size", {
      ...initial,
      revision: 1012,
      size: 140,
    });
    await notify({ ...initial, revision: 1013, size: 140 });
    await settings.evaluate(() => {
      window.dispatchEvent(new Event("pointerup"));
      window.dispatchEvent(new Event("blur"));
    });
    await settings.waitForTimeout(350);
    expect(await count("settings:size")).toBe(7);
    expect(await settings.locator("main").count()).toBe(0);
    await closeSettings(app);
    const reopened = await openSettings(app, { waitForInitialState: false });
    const newReads = (await count("settings:get")) - reads;
    for (let i = 0; i < newReads; i++)
      await finish("settings:get", initial, true);
    await expect
      .poll(() => reopened.locator(".error").textContent())
      .toContain("无法读取大小设置");
    await notify({ ...initial, revision: 1014, size: 140 });
    await expect
      .poll(() => reopened.locator("output").textContent())
      .toBe("140");
    expect(await reopened.locator(".error").isVisible()).toBe(false);
    await reopened.getByRole("combobox").selectOption("whale");
    await finish("settings:character", initial, true);
    await expect
      .poll(() => reopened.locator("#character-error").textContent())
      .toContain("无法确认角色切换结果");
    await notify({ ...initial, revision: 1015, size: 140, character: "whale" });
    await expect
      .poll(() => reopened.getByRole("combobox").inputValue())
      .toBe("whale");
    expect(await reopened.locator("#character-error").isVisible()).toBe(false);
    await mkdir("test-results", { recursive: true });
    await reopened.screenshot({
      fullPage: true,
      path: `test-results/settings-state-${packaged ? "packaged" : "development"}.png`,
    });
  } finally {
    await app?.close();
    await stop?.();
    await rm(root, { recursive: true, force: true });
  }
});
