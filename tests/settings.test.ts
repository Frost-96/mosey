import { distanceFromGround } from "./support/ground";
import { test, expect } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { openSettings, closeSettings } from "./support/settings";
import { createPetTestSession } from "./support/pet-session";
import { waitForPetVisibility } from "./support/visibility";
const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("settings owns presets, reuses its window and preserves hidden intent and failed targets", async () => {
  const session = await createPetTestSession({ dock: "empty" });
  let { app } = await session.launch();
  const stage = (name: string) => session.mark(name);
  const invoke = (label: string) =>
    session.run("settings:app.evaluate", () =>
      app!.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((x) => x.label === "Mosey")
          ?.submenu?.items.find((x) => x.label === label);
        if (!item) throw new Error(`Missing menu ${label}`);
        item.click();
      }, label),
    );
  const petState = () =>
    session.run("settings:app.evaluate", () =>
      app!.evaluate(({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        return {
          id: pet.id,
          visible: pet.isVisible(),
          bounds: pet.getBounds(),
        };
      }),
    );
  expect((await petState()).bounds.width).toBe(160);
  await stage("open settings");
  let settings = await openSettings(app, { run: session.run });
  await expect
    .poll(() =>
      session.run("settings:settings.getAttribute", () =>
        settings!
          .getByRole("button", { name: "中（默认）" })
          .getAttribute("aria-pressed"),
      ),
    )
    .toBe("true");
  await invoke("设置…");
  expect(app.windows()).toHaveLength(2);
  expect(
    await session.run("settings:settings.count", () =>
      settings.getByText("柯基", { exact: true }).count(),
    ),
  ).toBe(1);
  expect(
    await session.run("settings:settings.count", () =>
      settings.locator("canvas").count(),
    ),
  ).toBe(0);
  expect(
    await session.run("settings:app.evaluate", () =>
      app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()!
          .items.find((x) => x.label === "Mosey")!
          .submenu!.items.map((x) => x.label),
      ),
    ),
  ).toContain("Launch at Login");
  expect(
    await session.run("settings:app.evaluate", () =>
      app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()!
          .items.find((x) => x.label === "Mosey")!
          .submenu!.items.map((x) => x.label),
      ),
    ),
  ).toContain("Pet Size");
  await stage("validate IPC boundaries");
  expect(
    await session.run("settings:settings.evaluate", () =>
      settings.evaluate(() =>
        window.mosey.getPresentation().then(
          () => "allowed",
          () => "rejected",
        ),
      ),
    ),
  ).toBe("rejected");
  expect(
    await session.run("settings:app.evaluate", () =>
      app
        .windows()
        .find((w) => !new URL(w.url()).searchParams.has("settings"))!
        .evaluate(() =>
          window.moseySettings.get().then(
            () => "allowed",
            () => "rejected",
          ),
        ),
    ),
  ).toBe("rejected");

  await stage("hidden presets and save failure");
  const petId = (await petState()).id;
  await invoke("Hide Mosey");
  await expect
    .poll(() =>
      session.run("settings:settings.isVisible", () =>
        settings!.getByText("宠物已隐藏").isVisible(),
      ),
    )
    .toBe(true);
  await session.run("settings:settings.click", () =>
    settings.getByRole("button", { name: "小", exact: true }).click(),
  );
  await expect.poll(async () => (await petState()).bounds.width).toBe(70);
  expect((await petState()).visible).toBe(false);
  const file = path.join(session.profile, "preferences.json");
  await session.run("settings:rm", () => rm(file));
  await session.run("settings:mkdir", () => mkdir(file));
  await session.run("settings:settings.click", () =>
    settings.getByRole("button", { name: "大", exact: true }).click(),
  );
  await expect
    .poll(() =>
      session.run("settings:settings.textContent", () =>
        settings!.locator(".error [role=alert]").textContent(),
      ),
    )
    .toContain("保存失败");
  expect((await petState()).bounds.width).toBe(70);
  await session.run("settings:mkdir", () =>
    mkdir("test-results", { recursive: true }),
  );
  expect(
    await session.run("settings:settings.evaluate", () =>
      settings
        .locator("body")
        .evaluate((element) => getComputedStyle(element).overflowY),
    ),
  ).toBe("auto");
  const loginNote = settings.getByRole("region", { name: "开机启动" });
  await session.run("settings:loginNote.scrollIntoViewIfNeeded", () =>
    loginNote.scrollIntoViewIfNeeded(),
  );
  expect(
    await session.run("settings:loginNote.evaluate", () =>
      loginNote.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= innerHeight;
      }),
    ),
  ).toBe(true);
  await stage("save-error screenshot");
  await session.run("settings:settings.screenshot", () =>
    settings.screenshot({
      fullPage: true,
      path: `test-results/settings-${packaged ? "packaged" : "development"}-save-error.png`,
    }),
  );
  await stage("retry failed size");
  await session.run("settings:rm", () => rm(file, { recursive: true }));
  await session.run("settings:settings.click", () =>
    settings.getByRole("button", { name: "重试", exact: true }).click(),
  );
  await expect.poll(async () => (await petState()).bounds.width).toBe(240);
  await session.run("settings:settings.click", () =>
    settings.getByRole("button", { name: "显示宠物", exact: true }).click(),
  );
  await expect.poll(async () => (await petState()).visible).toBe(true);
  await invoke("Hide Mosey");
  await session.run("settings:rm", () => rm(file));
  await session.run("settings:mkdir", () => mkdir(file));
  await session.run("settings:settings.click", () =>
    settings.getByRole("button", { name: "小", exact: true }).click(),
  );
  await expect
    .poll(() =>
      session.run("settings:settings.isVisible", () =>
        settings!.locator(".error [role=alert]").isVisible(),
      ),
    )
    .toBe(true);
  await session.run("settings:rm", () => rm(file, { recursive: true }));
  await session.run("settings:settings.evaluate", () =>
    settings.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-size="70"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-size="160"]')!.click();
    }),
  );
  await expect.poll(async () => (await petState()).bounds.width).toBe(160);
  await expect
    .poll(() =>
      session.run("settings:settings.isVisible", () =>
        settings!.locator(".error [role=alert]").isVisible(),
      ),
    )
    .toBe(false);

  await stage("new presets");
  await session.run("settings:settings.click", () =>
    settings.getByRole("button", { name: "小", exact: true }).click(),
  );
  await session.run("settings:settings.click", () =>
    settings.getByRole("button", { name: "中（默认）" }).click(),
  );
  await expect.poll(async () => (await petState()).bounds.width).toBe(160);
  await session.run("settings:mkdir", () =>
    mkdir("test-results", { recursive: true }),
  );
  expect(
    await session.run("settings:settings.evaluate", () =>
      settings
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ),
  ).toBe("rgb(246, 245, 242)");
  expect(
    await session.run("settings:settings.evaluate", () =>
      settings
        .locator("body")
        .evaluate((element) => getComputedStyle(element).overflowY),
    ),
  ).toBe("auto");
  expect(
    await session.run("settings:settings.evaluate", () =>
      settings
        .locator("main")
        .evaluate((element) => getComputedStyle(element).paddingLeft),
    ),
  ).toBe("32px");
  await session.run("settings:settings.scrollIntoViewIfNeeded", () =>
    settings.getByRole("region", { name: "开机启动" }).scrollIntoViewIfNeeded(),
  );
  await stage("settings screenshot");
  await session.run("settings:settings.screenshot", () =>
    settings.screenshot({
      path: `test-results/settings-${packaged ? "packaged" : "development"}.png`,
    }),
  );
  await stage("close settings");
  await closeSettings(app, { run: session.run });
  expect((await petState()).id).toBe(petId);
  expect((await petState()).visible).toBe(false);
  settings = await openSettings(app, { run: session.run });
  await expect.poll(() => app!.windows().length).toBe(2);
  await stage("quit after reopening settings");
  await session.quit();
  await stage("restart");
  ({ app } = await session.launch());
  await stage("restart first window");
  expect((await petState()).bounds.width).toBe(160);
  expect((await petState()).visible).toBe(false);
  expect(
    JSON.parse(
      await session.run("settings:readFile", () => readFile(file, "utf8")),
    ),
  ).toEqual({
    version: 3,
    character: "whale",
    size: 160,
    visibility: "hidden",
  });
  await session.quit();
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
    expect(
      (await session.run("settings:renderer.read", () => renderer.read()))!
        .scaleFactor,
    ).toBe(Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"));
    const state = () =>
      session.run("settings:app.evaluate", () =>
        app.evaluate(({ BrowserWindow }) => {
          const pet = BrowserWindow.getAllWindows().find(
            (w) => w.getTitle() === "Mosey",
          )!;
          return { side: pet.getBounds().width, visible: pet.isVisible() };
        }),
      );
    session.mark("migrated-hidden-window");
    expect(await state()).toEqual({ side: size, visible: false });
    if (typeof old === "number") {
      session.mark("numeric-settings");
      const settings = await openSettings(app, { run: session.run });
      expect(
        await session.run("settings:settings.textContent", () =>
          settings.locator("output").textContent(),
        ),
      ).toBe("110");
      expect(
        await session.run("settings:settings.count", () =>
          settings.locator('[aria-pressed="true"]').count(),
        ),
      ).toBe(0);
      await session.run("settings:settings.click", () =>
        settings.getByRole("button", { name: "显示宠物", exact: true }).click(),
      );
      session.mark("numeric-visible-paint");
      await waitForPetVisibility(app, pet, "visible", { run: session.run });
      await expect
        .poll(() =>
          session.run("settings:pet.evaluate", () =>
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
          ),
        )
        .toBeGreaterThan(0.2);
      const bounds = () =>
        session.run("settings:app.evaluate", () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((w) => w.getTitle() === "Mosey")!
              .getBounds(),
          ),
        );
      const ground = await bounds();
      session.mark("numeric-drag-and-return");
      await session.run("settings:pet.move", () => pet.mouse.move(55, 82));
      await session.run("settings:pet.down", () => pet.mouse.down());
      await session.run("settings:pet.move", () => pet.mouse.move(55, -20));
      await expect
        .poll(async () => (await bounds()).y)
        .toBeLessThan(ground.y - 50);
      await session.run("settings:pet.up", () => pet.mouse.up());
      await expect
        .poll(
          () =>
            session.run("settings:distanceFromGround", () =>
              distanceFromGround(app),
            ),
          { timeout: 4000 },
        )
        .toBe(0);
      await session.run("settings:app.evaluate", () =>
        app.evaluate(({ Menu }) =>
          Menu.getApplicationMenu()!
            .items.find((x) => x.label === "Mosey")!
            .submenu!.items.find((x) => x.label === "Hide Mosey")!
            .click(),
        ),
      );
    }
    session.mark("quit-before-durability-check");
    await session.quit();
    session.mark("persisted-migration");
    expect(
      JSON.parse(
        await session.run("settings:readFile", () => readFile(file, "utf8")),
      ),
    ).toEqual({
      version: 3,
      character: "whale",
      visibility: "hidden",
      size,
    });
    if (typeof old !== "number") {
      session.mark("corrupt-primary-and-interrupted-write");
      await session.run("settings:writeFile", () => writeFile(file, "{broken"));
      await session.run("settings:writeFile", () =>
        writeFile(`${file}.tmp`, "interrupted"),
      );
      ({ app } = await session.launch());
      session.mark("backup-recovered-hidden-window");
      expect(await state()).toEqual({ side: size, visible: false });
      await session.quit();
    }
    session.mark("migration-complete");
  },
);
