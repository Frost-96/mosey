import { test, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { createPetTestSession } from "./support/pet-session";
import { writeCharacterFixture } from "./support/character-fixture";
import { evidencePath } from "./support/evidence";
import { onMainLoop } from "./support/main-loop";
import { menuIds } from "../src/main/menu-ids";
import type { Settings } from "../src/shared/contract";
import {
  characterCard,
  closeSettings,
  openSettings,
  selectedCharacter,
} from "./support/settings";

const mode = process.env.MOSEY_TEST_MODE;

// Decode a card's thumbnail as the page received it. The protocol answers with
// CORS headers, so an anonymous image can be read back from a canvas.
function thumbnail(page: Page, id: string) {
  return page.evaluate(
    (id) =>
      new Promise<{ width: number; height: number; bottom: number[] }>(
        (resolve, reject) => {
          const image = new Image();
          image.crossOrigin = "anonymous";
          image.onerror = () => reject(new Error(`No thumbnail for ${id}`));
          image.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);
            resolve({
              width: image.naturalWidth,
              height: image.naturalHeight,
              bottom: [
                ...context.getImageData(
                  Math.floor(image.naturalWidth / 2),
                  image.naturalHeight - 1,
                  1,
                  1,
                ).data,
              ],
            });
          };
          image.src = `mosey-asset://thumbnail/${id}`;
        },
      ),
    id,
  );
}

function settingsWindow(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.getTitle() === "Mosey 设置",
    )!;
    return {
      content: window.getContentSize(),
      resizable: window.isResizable(),
    };
  });
}

// Relative luminance of every painted background in the page, sampled from
// computed styles, so a hard-coded light surface shows up in either theme.
function surfaces(page: Page) {
  return page.evaluate(() => {
    const luminance = (color: string) => {
      const [r, g, b, a = 1] = color.match(/[\d.]+/g)!.map(Number);
      // Translucent tints take their lightness from the surface beneath.
      if (a < 0.5) return undefined;
      const channel = (value: number) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    const result: { element: string; luminance: number }[] = [];
    for (const element of [
      document.body,
      ...document.body.querySelectorAll("*"),
    ]) {
      if (
        !(element instanceof HTMLElement) ||
        (!element.offsetParent && element !== document.body)
      )
        continue;
      const value = luminance(getComputedStyle(element).backgroundColor);
      if (value !== undefined)
        result.push({
          element: `${element.tagName.toLowerCase()}.${element.className}`,
          luminance: value,
        });
    }
    return result;
  });
}

// Every visible or announced interface string, minus the product name and
// proper nouns supplied as data (character names, the operating system).
function latinInterfaceText(page: Page) {
  return page.evaluate(() => {
    const names = [...document.querySelectorAll(".character .name")].map(
      (name) => name.textContent!,
    );
    let text = [
      document.title,
      document.body.innerText,
      ...[...document.querySelectorAll("[aria-label]")].map((element) =>
        element.getAttribute("aria-label"),
      ),
      ...[...document.querySelectorAll("[aria-live], [role=alert]")].map(
        (element) => element.textContent,
      ),
    ].join("\n");
    for (const word of ["Mosey", "macOS", ...names])
      text = text.replaceAll(word, "");
    return text.match(/[A-Za-z]+/g) ?? [];
  });
}

test("character cards show generated thumbnails, fall back to an initial and stay selectable", async () => {
  const session = await createPetTestSession({ dock: "empty" });
  try {
    await writeCharacterFixture(session.profile);
    const broken = await writeCharacterFixture(session.profile, {
      id: "broken",
      name: "坏图角色",
    });
    await writeFile(path.join(broken, "idle-atlas.png"), "not a png");
    const { app, pet } = await session.launch();
    let settings = await openSettings(app);
    session.mark("built-in and installed thumbnails");
    for (const id of ["whale", "claude", "gemini", "gpt", "corgi", "minimal"])
      await expect
        .poll(() =>
          characterCard(settings, id)
            .locator("img.thumbnail")
            .evaluate(
              (image: HTMLImageElement) =>
                image.complete && image.naturalWidth > 0,
            ),
        )
        .toBe(true);
    // The fixture's first resting frame is a 140×240 magenta block inside a
    // 480 square: the thumbnail is that opaque block, fitted within 192.
    const installed = await thumbnail(settings, "minimal");
    expect(installed).toMatchObject({ width: 112, height: 192 });
    expect(installed.bottom).toEqual([220, 30, 210, 255]);
    session.mark("failed thumbnail placeholder");
    const placeholder = characterCard(settings, "broken").locator(
      ".placeholder",
    );
    await expect.poll(() => placeholder.textContent()).toBe("坏");
    expect(await characterCard(settings, "broken").locator("img").count()).toBe(
      0,
    );
    await characterCard(settings, "broken").click();
    await expect
      .poll(
        async () =>
          `${await settings.locator("#character-status").textContent()}${await settings.locator("#character-error").textContent()}`,
        { timeout: 20000 },
      )
      .toMatch(/坏图角色|素材加载失败/);
    expect(await pet.locator("canvas").getAttribute("aria-label")).toContain(
      "DeepSeek",
    );
    session.mark("updated package regenerates its thumbnail");
    await closeSettings(app);
    await writeCharacterFixture(session.profile, { color: [20, 220, 50] });
    settings = await openSettings(app);
    expect((await thumbnail(settings, "minimal")).bottom).toEqual([
      20, 220, 50, 255,
    ]);
    await settings.screenshot({
      fullPage: true,
      path: evidencePath(`settings-${mode}-thumbnails.png`),
    });
  } finally {
    await session.close();
  }
});

test("settings follows the system theme, speaks Chinese, fits its content and works from the keyboard", async () => {
  const session = await createPetTestSession({ dock: "empty" });
  try {
    const { app } = await session.launch();
    const petWidth = () =>
      app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey")!
            .getBounds().width,
      );
    const petVisible = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Mosey")!
          .isVisible(),
      );
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    const settings = await openSettings(app);
    session.mark("light theme");
    for (const surface of (await surfaces(settings)).filter(({ element }) =>
      /^(body|div\.card)/.test(element),
    ))
      expect(surface.luminance).toBeGreaterThan(0.8);
    expect(await latinInterfaceText(settings)).toEqual([]);
    expect(await settings.locator("h1").count()).toBe(0);

    session.mark("window fits content");
    const height = await settings
      .locator("main")
      .evaluate((main) => Math.ceil(main.getBoundingClientRect().height));
    await expect
      .poll(() => settingsWindow(app))
      .toEqual({ content: [460, height], resizable: false });

    session.mark("dark theme");
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await expect
      .poll(async () =>
        Math.max(...(await surfaces(settings)).map((s) => s.luminance)),
      )
      .toBeLessThan(0.3);
    await settings.screenshot({
      fullPage: true,
      path: evidencePath(`settings-${mode}-dark.png`),
    });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });

    session.mark("keyboard character choice");
    await settings.evaluate(() =>
      (document.activeElement as HTMLElement).blur(),
    );
    await settings.keyboard.press("Tab");
    expect(
      await settings.evaluate(
        () => (document.activeElement as HTMLInputElement).value,
      ),
    ).toBe("whale");
    await settings.keyboard.press("ArrowRight");
    await expect
      .poll(() => selectedCharacter(settings), { timeout: 15000 })
      .toBe("claude");

    session.mark("keyboard size");
    await settings.keyboard.press("Tab");
    expect(
      await settings.evaluate(() => document.activeElement!.textContent),
    ).toBe("小");
    await settings.keyboard.press("Enter");
    await expect.poll(petWidth).toBe(70);
    for (let i = 0; i < 3; i++) await settings.keyboard.press("Tab");
    expect(
      await settings.evaluate(() =>
        document.activeElement!.getAttribute("aria-label"),
      ),
    ).toBe("宠物大小");
    await settings.keyboard.press("ArrowRight");
    await expect.poll(petWidth).toBe(80);
    expect(await settings.locator("output").textContent()).toBe("80");

    session.mark("keyboard shows a hidden pet");
    await onMainLoop(
      app,
      ({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(),
      menuIds.hidePet,
    );
    await expect
      .poll(() => settings.getByText("宠物已隐藏").isVisible())
      .toBe(true);
    expect(await latinInterfaceText(settings)).toEqual([]);
    await settings.evaluate(() =>
      (document.activeElement as HTMLElement).blur(),
    );
    await settings.keyboard.press("Tab");
    expect(
      await settings.evaluate(() => document.activeElement!.textContent),
    ).toBe("显示宠物");
    await settings.keyboard.press("Enter");
    await expect.poll(petVisible).toBe(true);
    await expect.poll(() => settings.getByText("宠物已隐藏").count()).toBe(0);
  } finally {
    await session.close();
  }
});

// Maintainer evidence: one screenshot per settings state, rendered by the real
// page from snapshots delivered at the IPC boundary.
test("settings states render for review", async () => {
  const session = await createPetTestSession({ dock: "empty" });
  try {
    const { app } = await session.launch();
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    const settings = await openSettings(app);
    const base: Settings = await settings.evaluate(() =>
      window.moseySettings.get(),
    );
    const states: Record<string, Partial<Settings>> = {
      normal: { login: { status: "disabled" } },
      hidden: { visibility: "hidden", login: { status: "disabled" } },
      switching: {
        pendingCharacter: { target: "claude", phase: "loading" },
        login: { status: "disabled" },
      },
      "switch-failed": {
        failedCharacter: { target: "claude", reason: "load" },
        login: { status: "disabled" },
      },
      "size-failed": { failedSize: 240, login: { status: "disabled" } },
      "login-pending": { login: { status: "requires-approval" } },
      "login-unavailable": {
        login: {
          status: "unavailable",
          reason: "开机启动仅适用于打包后的 macOS 应用。",
        },
      },
    };
    let revision = 1_000_000;
    for (const [name, patch] of Object.entries(states)) {
      session.mark(`state ${name}`);
      revision += 1;
      await app.evaluate(
        ({ BrowserWindow }, snapshot) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey 设置")!
            .webContents.send("settings:state", snapshot),
        { ...base, ...patch, revision },
      );
      await settings.waitForTimeout(200);
      expect(await latinInterfaceText(settings)).toEqual([]);
      await settings.screenshot({
        fullPage: true,
        path: evidencePath(`settings-${mode}-state-${name}.png`),
      });
    }
  } finally {
    await session.close();
  }
});
