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
const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("settings owns presets, reuses its window and preserves hidden intent and failed targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-settings-"));
  let app: ElectronApplication | undefined;
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
    const child = app?.process();
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
              args: [`--user-data-dir=${profile}`],
            }
          : { args: [".", `--user-data-dir=${profile}`] },
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
    await stage("first window");
    await app.firstWindow();
    expect((await petState()).bounds.width).toBe(160);
    await stage("open settings");
    await invoke("设置…");
    await expect
      .poll(() =>
        app!
          .windows()
          .find((w) => new URL(w.url()).searchParams.has("settings")),
      )
      .toBeTruthy();
    settings = app
      .windows()
      .find((w) => new URL(w.url()).searchParams.has("settings"))!;
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
    ).not.toContain("Launch at Login");
    expect(
      await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()!
          .items.find((x) => x.label === "Mosey")!
          .submenu!.items.map((x) => x.label),
      ),
    ).not.toContain("Size");
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
    await mkdir("docs/validation", { recursive: true });
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
      path: `docs/validation/issue-31-${packaged ? "packaged" : "development"}-save-error.png`,
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
    await mkdir("docs/validation", { recursive: true });
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
      path: `docs/validation/issue-31-${packaged ? "packaged" : "development"}-settings.png`,
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
    await stage("restart first window");
    await app.firstWindow();
    expect((await petState()).bounds.width).toBe(160);
    expect((await petState()).visible).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 2,
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

test("old presets and hidden intent migrate durably, recover backup and accept numeric steps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-migration-"));
  let app: ElectronApplication | undefined;
  let stop: (() => Promise<void>) | undefined;
  try {
    if (!packaged) stop = await startForge();
    else
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    for (const [old, size] of [
      ["small", 70],
      ["medium", 160],
      ["large", 240],
      [undefined, 160],
      [110, 110],
    ] as const) {
      const profile = path.join(root, String(size) + String(old));
      await mkdir(profile, { recursive: true });
      const file = path.join(profile, "preferences.json");
      await writeFile(
        file,
        JSON.stringify({
          version: typeof old === "number" ? 2 : 1,
          visibility: "hidden",
          size: old,
        }),
      );
      const launch = () =>
        electron.launch(
          packaged
            ? {
                executablePath: path.join(
                  root,
                  "Mosey.app/Contents/MacOS/Mosey",
                ),
                args: [`--user-data-dir=${profile}`],
              }
            : { args: [".", `--user-data-dir=${profile}`] },
        );
      app = await launch();
      const pet = await app.firstWindow();
      await pet.waitForLoadState("load");
      const state = () =>
        app!.evaluate(({ BrowserWindow }) => {
          const pet = BrowserWindow.getAllWindows().find(
            (w) => w.getTitle() === "Mosey",
          )!;
          return { side: pet.getBounds().width, visible: pet.isVisible() };
        });
      expect(await state()).toEqual({ side: size, visible: false });
      if (typeof old === "number") {
        const settings = await openSettings(app);
        expect(await settings.locator("output").textContent()).toBe("110");
        expect(await settings.locator('[aria-pressed="true"]').count()).toBe(0);
        await settings
          .getByRole("button", { name: "显示宠物", exact: true })
          .click();
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
          app!.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((w) => w.getTitle() === "Mosey")!
              .getBounds(),
          );
        const ground = await bounds();
        await pet.mouse.move(55, 82);
        await pet.mouse.down();
        await pet.mouse.move(55, -20);
        await expect
          .poll(async () => (await bounds()).y)
          .toBeLessThan(ground.y - 50);
        await pet.mouse.up();
        await expect
          .poll(() => distanceFromGround(app!), { timeout: 4000 })
          .toBe(0);
        await app.evaluate(({ Menu }) =>
          Menu.getApplicationMenu()!
            .items.find((x) => x.label === "Mosey")!
            .submenu!.items.find((x) => x.label === "Hide Mosey")!
            .click(),
        );
      }
      await app.close();
      app = undefined;
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        version: 2,
        visibility: "hidden",
        size,
      });
      if (typeof old !== "number") {
        await writeFile(file, "{broken");
        await writeFile(`${file}.tmp`, "interrupted");
        app = await launch();
        await app.firstWindow();
        expect(await state()).toEqual({ side: size, visible: false });
        await app.close();
        app = undefined;
      }
    }
  } catch (error) {
    await mkdir("test-results", { recursive: true });
    await app
      ?.windows()[0]
      ?.screenshot({
        path: `test-results/failure-migration-${packaged ? "packaged" : "development"}.png`,
        timeout: 3000,
      })
      .catch(() => {});
    throw error;
  } finally {
    await app?.close().catch(() => {});
    await stop?.();
    await rm(root, { recursive: true, force: true });
  }
});
