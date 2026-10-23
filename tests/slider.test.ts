import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { startForge } from "./support/forge";
import { openSettings } from "./support/settings";
const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("slider previews without saving, commits on release, and persists nonpreset sizes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-slider-"));
  const profile = path.join(root, "profile");
  let app: ElectronApplication | undefined;
  let stop: (() => Promise<void>) | undefined;
  try {
    await mkdir(profile, { recursive: true });
    await writeFile(
      path.join(profile, "preferences.json"),
      JSON.stringify({ version: 2, size: 160, visibility: "visible" }),
    );
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
    app = await launch();
    await app.firstWindow();
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
    const bounds = (await slider.boundingBox())!;
    await settings.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await settings.mouse.down();
    await settings.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2, {
      steps: 4,
    });
    await expect.poll(side).toBe(70);
    expect(JSON.parse(await readFile(file, "utf8")).size).toBe(160);
    await settings.mouse.up();
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
    await app.evaluate(({ Menu }) =>
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
    const closingBounds = (await slider.boundingBox())!;
    await settings.mouse.move(
      closingBounds.x + closingBounds.width / 2,
      closingBounds.y + closingBounds.height / 2,
    );
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
    await expect
      .poll(async () => JSON.parse(await readFile(file, "utf8")).size)
      .toBe(70);
    await app.close();
    app = await launch();
    await app.firstWindow();
    expect(await side()).toBe(70);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .isVisible(),
      ),
    ).toBe(false);
  } finally {
    await app?.close().catch(() => {});
    await stop?.();
    await rm(root, { recursive: true, force: true });
  }
});
