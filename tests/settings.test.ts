import { distanceFromGround } from "./support/ground";
import { test, expect, onTestFailed } from "vitest";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startForge } from "./support/forge";
import { openSettings } from "./support/settings";
import { createPetTestSession } from "./support/pet-session";
const packaged = process.env.MOSEY_TEST_MODE === "packaged";
const scaleArgument = `--force-device-scale-factor=${process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"}`;
test("settings owns presets, reuses its window and preserves hidden intent and failed targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-settings-"));
  let app: ElectronApplication | undefined;
  let applicationProcess:
    ReturnType<ElectronApplication["process"]> | undefined;
  let stop: (() => Promise<void>) | undefined;
  let settings: Page | undefined;
  const profile = path.join(root, "profile");
  const progressFile = `test-results/${packaged ? "packaged" : "development"}-settings-progress.json`;
  const progress: { stage: string; at: number }[] = [];
  const stage = async (name: string) => {
    progress.push({ stage: name, at: Date.now() });
    await mkdir("test-results", { recursive: true });
    await writeFile(progressFile, JSON.stringify(progress, null, 2));
  };
  onTestFailed(async () => {
    await stage("test failed");
    await (settings ?? app?.windows()[0])
      ?.screenshot({
        path: `test-results/failure-settings-${packaged ? "packaged" : "development"}.png`,
        timeout: 3000,
      })
      .catch(() => {});
    // Vitest's test timeout does not unwind an outstanding Playwright call.
    // Release only this test's process so its pending calls and finally settle.
    const child = applicationProcess;
    if (child?.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  });
  try {
    await stage("prepare app");
    if (!packaged) stop = await startForge();
    else
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    const launch = () =>
      electron.launch(
        packaged
          ? {
              executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
              args: [scaleArgument, `--user-data-dir=${profile}`],
            }
          : { args: [".", scaleArgument, `--user-data-dir=${profile}`] },
      );
    const invoke = (label: string) =>
      app!.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((x) => x.label === "Mosey")
          ?.submenu?.items.find((x) => x.label === label);
        if (!item) throw new Error(`Missing menu ${label}`);
        item.click();
      }, label);
    const petState = () =>
      app!.evaluate(({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        return {
          id: pet.id,
          visible: pet.isVisible(),
          bounds: pet.getBounds(),
        };
      });
    await stage("launch");
    app = await launch();
    applicationProcess = app.process();
    await stage("first window");
    await app.firstWindow();
    expect((await petState()).bounds.width).toBe(160);
    await stage("open settings");
    settings = await openSettings(app);
    await expect
      .poll(() =>
        settings!
          .getByRole("button", { name: "中（默认）" })
          .getAttribute("aria-pressed"),
      )
      .toBe("true");
    await invoke("设置…");
    expect(app.windows()).toHaveLength(2);
    expect(await settings.getByText("柯基", { exact: true }).count()).toBe(1);
    expect(await settings.locator("canvas").count()).toBe(0);
    expect(
      await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()!
          .items.find((x) => x.label === "Mosey")!
          .submenu!.items.map((x) => x.label),
      ),
    ).toContain("Launch at Login");
    expect(
      await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()!
          .items.find((x) => x.label === "Mosey")!
          .submenu!.items.map((x) => x.label),
      ),
    ).toContain("Pet Size");
    await stage("validate IPC boundaries");
    expect(
      await settings.evaluate(() =>
        window.mosey.getPresentation().then(
          () => "allowed",
          () => "rejected",
        ),
      ),
    ).toBe("rejected");
    expect(
      await app
        .windows()
        .find((w) => !new URL(w.url()).searchParams.has("settings"))!
        .evaluate(() =>
          window.moseySettings.get().then(
            () => "allowed",
            () => "rejected",
          ),
        ),
    ).toBe("rejected");

    await stage("hidden presets and save failure");
    const petId = (await petState()).id;
    await invoke("Hide Mosey");
    await expect
      .poll(() => settings!.getByText("宠物已隐藏").isVisible())
      .toBe(true);
    await settings.getByRole("button", { name: "小", exact: true }).click();
    await expect.poll(async () => (await petState()).bounds.width).toBe(70);
    expect((await petState()).visible).toBe(false);
    const file = path.join(profile, "preferences.json");
    await rm(file);
    await mkdir(file);
    await settings.getByRole("button", { name: "大", exact: true }).click();
    await expect
      .poll(() => settings!.locator(".error [role=alert]").textContent())
      .toContain("保存失败");
    expect((await petState()).bounds.width).toBe(70);
    await mkdir("test-results", { recursive: true });
    expect(
      await settings
        .locator("body")
        .evaluate((element) => getComputedStyle(element).overflowY),
    ).toBe("auto");
    const loginNote = settings.getByRole("region", { name: "开机启动" });
    await loginNote.scrollIntoViewIfNeeded();
    expect(
      await loginNote.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= innerHeight;
      }),
    ).toBe(true);
    await stage("save-error screenshot");
    await settings.screenshot({
      fullPage: true,
      path: `test-results/settings-${packaged ? "packaged" : "development"}-save-error.png`,
    });
    await stage("retry failed size");
    await rm(file, { recursive: true });
    await settings.getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(async () => (await petState()).bounds.width).toBe(240);
    await settings
      .getByRole("button", { name: "显示宠物", exact: true })
      .click();
    await expect.poll(async () => (await petState()).visible).toBe(true);
    await invoke("Hide Mosey");
    await rm(file);
    await mkdir(file);
    await settings.getByRole("button", { name: "小", exact: true }).click();
    await expect
      .poll(() => settings!.locator(".error [role=alert]").isVisible())
      .toBe(true);
    await rm(file, { recursive: true });
    await settings.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-size="70"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-size="160"]')!.click();
    });
    await expect.poll(async () => (await petState()).bounds.width).toBe(160);
    await expect
      .poll(() => settings!.locator(".error [role=alert]").isVisible())
      .toBe(false);

    await stage("new presets");
    await settings.getByRole("button", { name: "小", exact: true }).click();
    await settings.getByRole("button", { name: "中（默认）" }).click();
    await expect.poll(async () => (await petState()).bounds.width).toBe(160);
    await mkdir("test-results", { recursive: true });
    expect(
      await settings
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe("rgb(246, 245, 242)");
    expect(
      await settings
        .locator("body")
        .evaluate((element) => getComputedStyle(element).overflowY),
    ).toBe("auto");
    expect(
      await settings
        .locator("main")
        .evaluate((element) => getComputedStyle(element).paddingLeft),
    ).toBe("32px");
    await settings
      .getByRole("region", { name: "开机启动" })
      .scrollIntoViewIfNeeded();
    await stage("settings screenshot");
    await settings.screenshot({
      path: `test-results/settings-${packaged ? "packaged" : "development"}.png`,
    });
    await stage("close settings");
    await settings.close();
    settings = undefined;
    expect((await petState()).id).toBe(petId);
    expect((await petState()).visible).toBe(false);
    await invoke("设置…");
    await expect.poll(() => app!.windows().length).toBe(2);
    await stage("quit after reopening settings");
    await app.close();
    await stage("restart");
    app = await launch();
    applicationProcess = app.process();
    await stage("restart first window");
    await app.firstWindow();
    expect((await petState()).bounds.width).toBe(160);
    expect((await petState()).visible).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 3,
      character: "whale",
      size: 160,
      visibility: "hidden",
    });
  } catch (error) {
    await mkdir("test-results", { recursive: true });
    await (settings ?? app?.windows()[0])
      ?.screenshot({
        path: `test-results/failure-settings-${packaged ? "packaged" : "development"}.png`,
        timeout: 3000,
      })
      .catch(() => {});
    throw error;
  } finally {
    await stage("cleanup app");
    await app?.close().catch(() => {});
    await stop?.();
    await rm(root, { recursive: true, force: true });
    await stage("complete");
  }
});

test.each([
  ["small", 70],
  ["medium", 160],
  ["large", 240],
  [undefined, 160],
  [110, 110],
] as const)(
  "old %s preset retains %i DIP and hidden intent across durable migration",
  async (old, size) => {
    const session = await createPetTestSession({
      // This scenario validates preferences and ordinary ground interaction;
      // real Dock capture/permissions have their own unchanged acceptance.
      dock: "empty",
      preferences: {
        version: typeof old === "number" ? 2 : 1,
        visibility: "hidden",
        size: old,
      },
    });
    const { app: initialApp, pet, renderer } = await session.launch();
    let app = initialApp;
    const file = path.join(session.profile, "preferences.json");
    expect((await renderer.read())!.scaleFactor).toBe(
      Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
    );
    const state = () =>
      app.evaluate(({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        return { side: pet.getBounds().width, visible: pet.isVisible() };
      });
    const quit = async () => {
      const child = app.process();
      // Judge the real process exit, not a driver close acknowledgement that
      // can remain pending after the application has already exited.
      void app
        .evaluate(({ Menu }) => {
          Menu.getApplicationMenu()!
            .items.find((item) => item.label === "Mosey")!
            .submenu!.items.find((item) => item.label === "Quit Mosey")!
            .click();
        })
        .catch(() => {});
      await expect.poll(() => child.exitCode, { timeout: 10000 }).toBe(0);
    };
    session.mark("migrated-hidden-window");
    expect(await state()).toEqual({ side: size, visible: false });
    if (typeof old === "number") {
      session.mark("numeric-settings");
      const settings = await openSettings(app);
      expect(await settings.locator("output").textContent()).toBe("110");
      expect(await settings.locator('[aria-pressed="true"]').count()).toBe(0);
      await settings
        .getByRole("button", { name: "显示宠物", exact: true })
        .click();
      session.mark("numeric-visible-paint");
      await renderer.waitUntilReady({ paintedPixels: 0 });
      await expect
        .poll(() =>
          pet.evaluate(() => {
            const canvas = document.querySelector("canvas")!;
            const data = canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height).data;
            let opaque = 0;
            for (let i = 3; i < data.length; i += 4)
              if (data[i] > 127) opaque++;
            return opaque / (canvas.width * canvas.height);
          }),
        )
        .toBeGreaterThan(0.2);
      const bounds = () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.getTitle() === "Mosey")!
            .getBounds(),
        );
      const ground = await bounds();
      session.mark("numeric-drag-and-return");
      await pet.mouse.move(55, 82);
      await pet.mouse.down();
      await pet.mouse.move(55, -20);
      await expect
        .poll(async () => (await bounds()).y)
        .toBeLessThan(ground.y - 50);
      await pet.mouse.up();
      await expect
        .poll(() => distanceFromGround(app), { timeout: 4000 })
        .toBe(0);
      await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()!
          .items.find((x) => x.label === "Mosey")!
          .submenu!.items.find((x) => x.label === "Hide Mosey")!
          .click(),
      );
    }
    session.mark("quit-before-durability-check");
    await quit();
    session.mark("persisted-migration");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 3,
      character: "whale",
      visibility: "hidden",
      size,
    });
    if (typeof old !== "number") {
      session.mark("corrupt-primary-and-interrupted-write");
      await writeFile(file, "{broken");
      await writeFile(`${file}.tmp`, "interrupted");
      ({ app } = await session.restart());
      session.mark("backup-recovered-hidden-window");
      expect(await state()).toEqual({ side: size, visible: false });
      await quit();
    }
    session.mark("migration-complete");
  },
);
