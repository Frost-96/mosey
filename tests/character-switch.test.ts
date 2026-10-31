import { controlBehavior, advanceRest } from "./support/controlled-behavior";
import { test, expect } from "vitest";
import type { Page } from "playwright";
import { rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { openSettings, closeSettings } from "./support/settings";

// An independent image-identity observation: the whale has blue hair/clothes;
// corgi is warm orange. No atlas metadata or redraw implementation is used.
async function paintedCharacter(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const pixels = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0,
      blue = 0,
      warm = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]! < 128) continue;
      opaque++;
      const r = pixels[i]!,
        g = pixels[i + 1]!,
        b = pixels[i + 2]!;
      if (b > r + 25 && b > g + 10) blue++;
      if (r > b + 40 && r > g + 15 && g > b + 10) warm++;
    }
    if (opaque < 500) return "blank";
    if (blue / opaque > 0.35 && warm / opaque < 0.1) return "whale";
    if (warm / opaque > 0.4 && blue / opaque < 0.05) return "corgi";
    return "unknown";
  });
}

test.each([
  { name: "new", previous: undefined },
  {
    name: "version 1",
    previous: { version: 1, size: "large", visibility: "hidden" },
  },
  {
    name: "version 2",
    previous: { version: 2, size: 70, visibility: "hidden" },
  },
])(
  "$name profile chooses whale while retaining size and hidden intent",
  async ({ previous }) => {
    const f = await createPetTestSession({
      dock: "empty",
      preferences: previous,
    });

    const { app, pet } = await f.launch();
    const settings = await openSettings(app, { run: f.run });
    await expect
      .poll(() =>
        f.run("character-switch:settings.inputValue", () =>
          settings.getByRole("combobox", { name: "角色" }).inputValue(),
        ),
      )
      .toBe("whale");
    await expect
      .poll(() =>
        f.run("character-switch:pet.getAttribute", () =>
          pet.locator("canvas").getAttribute("aria-label"),
        ),
      )
      .toBe("鲸鱼娘 · 待机");
    const actual = await f.run("character-switch:app.evaluate", () =>
      app.evaluate(({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        return { size: pet.getBounds().width, visible: pet.isVisible() };
      }),
    );
    expect(actual).toEqual({
      size: previous?.size === "large" ? 240 : (previous?.size ?? 160),
      visible: !previous,
    });

    await f.quit();
    await f.close();
  },
);

test("selection replaces the one pet, retains hidden size and location, and survives reopen and restart", async () => {
  const f = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "whale",
      size: 70,
      visibility: "hidden",
    },
  });

  let { app, pet } = await f.launch();
  let settings = await openSettings(app, { run: f.run });
  const native = () =>
    f.run("character-switch:app.evaluate", () =>
      app.evaluate(({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        return {
          id: pet.id,
          bounds: pet.getBounds(),
          visible: pet.isVisible(),
          pets: BrowserWindow.getAllWindows().filter(
            (w) => w.getTitle() === "Mosey",
          ).length,
        };
      }),
    );
  const before = await native();
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("corgi"),
  );
  await expect
    .poll(
      () =>
        f.run("character-switch:pet.getAttribute", () =>
          pet.locator("canvas").getAttribute("aria-label"),
        ),
      {
        timeout: 10000,
      },
    )
    .toBe("柯基 · 待机");
  expect(await native()).toEqual(before);
  await closeSettings(app, { run: f.run });
  settings = await openSettings(app, { run: f.run });
  await expect
    .poll(() =>
      f.run("character-switch:settings.inputValue", () =>
        settings.getByRole("combobox", { name: "角色" }).inputValue(),
      ),
    )
    .toBe("corgi");
  await f.quit();
  ({ app, pet } = await f.launch());
  settings = await openSettings(app, { run: f.run });
  await expect
    .poll(() =>
      f.run("character-switch:settings.inputValue", () =>
        settings.getByRole("combobox", { name: "角色" }).inputValue(),
      ),
    )
    .toBe("corgi");
  expect((await native()).visible).toBe(false);
  expect((await native()).bounds.width).toBe(70);
  await f.run("character-switch:settings.click", () =>
    settings.getByRole("button", { name: "显示宠物", exact: true }).click(),
  );
  await expect
    .poll(() =>
      f.run("character-switch:pet.evaluate", () =>
        pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          return Array.from(pixels).filter(
            (value, i) => i % 4 === 3 && value > 127,
          ).length;
        }),
      ),
    )
    .toBeGreaterThan(500);

  await f.quit();
  await f.close();
});

test("failed persistence keeps the actual and saved character, and retries the failed target", async () => {
  const f = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "whale",
      size: 160,
      visibility: "hidden",
    },
  });

  let { app, pet } = await f.launch();
  let settings = await openSettings(app, { run: f.run });
  const obstacle = path.join(f.profile, "preferences.json.tmp");
  await f.run("character-switch:mkdir", () => mkdir(obstacle));
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("corgi"),
  );
  await expect
    .poll(
      () =>
        f.run("character-switch:settings.textContent", () =>
          settings.locator("#character-error").textContent(),
        ),
      {
        timeout: 10000,
      },
    )
    .toContain("保存失败");
  expect(
    await f.run("character-switch:pet.getAttribute", () =>
      pet.locator("canvas").getAttribute("aria-label"),
    ),
  ).toBe("鲸鱼娘 · 待机");
  expect(
    await f.run("character-switch:settings.inputValue", () =>
      settings.getByRole("combobox", { name: "角色" }).inputValue(),
    ),
  ).toBe("whale");
  await closeSettings(app, { run: f.run });
  settings = await openSettings(app, { run: f.run });
  expect(
    await f.run("character-switch:settings.isVisible", () =>
      settings.locator("#character-error").isVisible(),
    ),
  ).toBe(true);
  await f.run("character-switch:rm", () => rm(obstacle, { recursive: true }));
  await f.run("character-switch:settings.click", () =>
    settings.getByRole("button", { name: "重试角色" }).click(),
  );
  await expect
    .poll(() =>
      f.run("character-switch:pet.getAttribute", () =>
        pet.locator("canvas").getAttribute("aria-label"),
      ),
    )
    .toBe("柯基 · 待机");
  await f.quit();
  ({ app, pet } = await f.launch());
  settings = await openSettings(app, { run: f.run });
  await expect
    .poll(() =>
      f.run("character-switch:settings.inputValue", () =>
        settings.getByRole("combobox", { name: "角色" }).inputValue(),
      ),
    )
    .toBe("corgi");
  await expect
    .poll(() =>
      f.run("character-switch:pet.getAttribute", () =>
        pet.locator("canvas").getAttribute("aria-label"),
      ),
    )
    .toBe("柯基 · 待机");

  await f.quit();
  await f.close();
});

test("image failure and a superseded delayed response cannot replace the newest choice across settings lifetimes", async () => {
  const f = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      size: 240,
      visibility: "visible",
    },
  });

  let { app, pet } = await f.launch();
  let settings = await openSettings(app, { run: f.run });
  await expect
    .poll(() =>
      f.run("character-switch:pet.getAttribute", () =>
        pet.locator("canvas").getAttribute("aria-label"),
      ),
    )
    .toBe("柯基 · 待机");
  await expect
    .poll(() =>
      f.run("character-switch:paintedCharacter", () => paintedCharacter(pet)),
    )
    .toBe("corgi");
  // Substitute only the image transport boundary, retaining the app's URL
  // allowlist. Delayed callbacks belong to the test's Electron session.
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(({ session }, origin) => {
      const control = {
        mode: "fail",
        callbacks: [] as ((value: { cancel: boolean }) => void)[],
      };
      Reflect.set(globalThis, "imageTransport", control);
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        const allowed =
          url.protocol === "file:" ||
          url.protocol === "data:" ||
          url.origin === origin ||
          (url.protocol === "ws:" && url.host === new URL(origin).host);
        if (!allowed) return callback({ cancel: true });
        if (details.resourceType === "image") {
          if (control.mode === "hold") {
            control.callbacks.push(callback);
            return;
          }
          if (control.mode === "fail") return callback({ cancel: true });
        }
        callback({ cancel: false });
      });
    }, new URL(pet.url()).origin),
  );
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("whale"),
  );
  await expect
    .poll(
      () =>
        f.run("character-switch:settings.textContent", () =>
          settings.locator("#character-error").textContent(),
        ),
      {
        timeout: 10000,
      },
    )
    .toContain("素材加载失败");
  await expect
    .poll(() =>
      f.run("character-switch:pet.getAttribute", () =>
        pet.locator("canvas").getAttribute("aria-label"),
      ),
    )
    .toBe("柯基 · 待机");
  expect(
    await f.run("character-switch:paintedCharacter", () =>
      paintedCharacter(pet),
    ),
  ).toBe("corgi");
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(() => {
      Reflect.get(globalThis, "imageTransport").mode = "hold";
    }),
  );
  await f.run("character-switch:settings.click", () =>
    settings.getByRole("button", { name: "重试角色" }).click(),
  );
  await expect
    .poll(() =>
      f.run("character-switch:app.evaluate", () =>
        app.evaluate(
          () => Reflect.get(globalThis, "imageTransport").callbacks.length,
        ),
      ),
    )
    .toBeGreaterThan(0);
  await closeSettings(app, { run: f.run });
  settings = await openSettings(app, { run: f.run });
  await expect
    .poll(() =>
      f.run("character-switch:settings.textContent", () =>
        settings.locator("#character-status").textContent(),
      ),
    )
    .toContain("正在准备鲸鱼娘");
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("corgi"),
  );
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(() => {
      const control = Reflect.get(globalThis, "imageTransport");
      control.mode = "allow";
      for (const callback of control.callbacks.splice(0))
        callback({ cancel: true });
    }),
  );
  await expect
    .poll(() =>
      f.run("character-switch:settings.textContent", () =>
        settings.locator("#character-status").textContent(),
      ),
    )
    .toBe("当前角色：柯基");
  // Let the obsolete decode rejection reach the real main process.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(
    await f.run("character-switch:settings.isVisible", () =>
      settings.locator("#character-error").isVisible(),
    ),
  ).toBe(false);
  await expect
    .poll(() =>
      f.run("character-switch:pet.getAttribute", () =>
        pet.locator("canvas").getAttribute("aria-label"),
      ),
    )
    .toBe("柯基 · 待机");
  await f.quit();
  ({ app, pet } = await f.launch());
  settings = await openSettings(app, { run: f.run });
  await expect
    .poll(() =>
      f.run("character-switch:settings.inputValue", () =>
        settings.getByRole("combobox", { name: "角色" }).inputValue(),
      ),
    )
    .toBe("corgi");
  await expect
    .poll(() =>
      f.run("character-switch:paintedCharacter", () => paintedCharacter(pet)),
    )
    .toBe("corgi");
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("whale"),
  );
  await expect
    .poll(
      () =>
        f.run("character-switch:pet.getAttribute", () =>
          pet.locator("canvas").getAttribute("aria-label"),
        ),
      {
        timeout: 10000,
      },
    )
    .toBe("鲸鱼娘 · 待机");
  await expect
    .poll(() =>
      f.run("character-switch:paintedCharacter", () => paintedCharacter(pet)),
    )
    .toBe("whale");
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("corgi"),
  );
  await expect
    .poll(() =>
      f.run("character-switch:paintedCharacter", () => paintedCharacter(pet)),
    )
    .toBe("corgi");
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("whale"),
  );
  await expect
    .poll(() =>
      f.run("character-switch:paintedCharacter", () => paintedCharacter(pet)),
    )
    .toBe("whale");
  await f.run("character-switch:settings.evaluate", () =>
    settings
      .getByRole("combobox", { name: "角色" })
      .evaluate((element: HTMLSelectElement) => {
        for (const target of ["corgi", "whale", "whale"]) {
          element.value = target;
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(
    await f.run("character-switch:paintedCharacter", () =>
      paintedCharacter(pet),
    ),
  ).toBe("whale");
  expect(
    await f.run("character-switch:settings.isVisible", () =>
      settings.locator("#character-error").isVisible(),
    ),
  ).toBe(false);
  expect(
    await f.run("character-switch:settings.textContent", () =>
      settings.locator("#character-status").textContent(),
    ),
  ).toBe("当前角色：鲸鱼娘");

  await f.quit();
  await f.close();
});

test("a timed-out preparation keeps the saved choice and cannot complete a later retry", async () => {
  const f = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      size: 160,
      visibility: "visible",
    },
  });

  let { app, pet } = await f.launch();
  let settings = await openSettings(app, { run: f.run });
  await f.run("character-switch:pet.evaluate", () =>
    pet.evaluate(() => {
      window.mosey.onPrepareCharacter((request) => {
        // Retain an old message at the renderer IPC boundary, not module state.
        if (!Reflect.has(window, "expiredPreparation"))
          Reflect.set(window, "expiredPreparation", request);
      });
    }),
  );
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Mosey",
      )!.webContents;
      const callbacks: ((value: { cancel: boolean }) => void)[] = [];
      Reflect.set(globalThis, "heldPreparationImages", callbacks);
      contents.session.webRequest.onBeforeRequest((details, callback) => {
        if (
          details.webContentsId === contents.id &&
          details.resourceType === "image"
        )
          callbacks.push(callback);
        else callback({ cancel: false });
      });
    }),
  );
  f.mark("request-held-preparation");
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("whale"),
  );
  await expect
    .poll(
      () =>
        f.run("character-switch:app.evaluate", () =>
          app.evaluate(
            () => Reflect.get(globalThis, "heldPreparationImages").length,
          ),
        ),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0);
  f.mark("wait-for-preparation-timeout");
  try {
    await expect
      .poll(
        () =>
          f.run("character-switch:settings.evaluate", () =>
            settings.evaluate(
              () =>
                document.querySelector("#character-error")?.textContent ?? "",
            ),
          ),
        { timeout: 20000 },
      )
      .toContain("素材加载失败");
  } catch (error) {
    // Preserve available state before registered failure cleanup closes the
    // app. A failed diagnostic read must not replace the original error.
    const observation = await Promise.race([
      Promise.all([
        f.run("character-switch:settings.evaluate", () =>
          settings.evaluate(() => document.body.innerText),
        ),
        f.run("character-switch:pet.evaluate", () =>
          pet.evaluate(() => window.mosey.getPresentation()),
        ),
        f.run("character-switch:app.evaluate", () =>
          app.evaluate(
            () => Reflect.get(globalThis, "heldPreparationImages").length,
          ),
        ),
      ]).catch(String),
      new Promise((resolve) =>
        setTimeout(() => resolve("Driver observation stalled"), 1000),
      ),
    ]);
    await f
      .run("character-switch:writeFile", () =>
        writeFile(
          `test-results/preparation-timeout-${process.env.MOSEY_TEST_MODE}-${process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"}x.json`,
          JSON.stringify({ error: String(error), observation }, null, 2),
        ),
      )
      .catch(() => {});
    throw error;
  }
  f.mark("preparation-timeout-reported");
  expect(
    await f.run("character-switch:paintedCharacter", () =>
      paintedCharacter(pet),
    ),
  ).toBe("corgi");
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(() => {
      for (const callback of Reflect.get(
        globalThis,
        "heldPreparationImages",
      ).splice(0))
        callback({ cancel: true });
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  await f.run("character-switch:settings.click", () =>
    settings.getByRole("button", { name: "重试角色" }).click(),
  );
  await expect
    .poll(() =>
      f.run("character-switch:app.evaluate", () =>
        app.evaluate(
          () => Reflect.get(globalThis, "heldPreparationImages").length,
        ),
      ),
    )
    .toBeGreaterThan(0);
  await f.run("character-switch:pet.evaluate", () =>
    pet.evaluate(() => {
      window.mosey.characterPrepared({
        ...Reflect.get(window, "expiredPreparation"),
        success: true,
      });
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(
    await f.run("character-switch:settings.textContent", () =>
      settings.locator("#character-status").textContent(),
    ),
  ).toContain("正在准备鲸鱼娘");
  expect(
    await f.run("character-switch:paintedCharacter", () =>
      paintedCharacter(pet),
    ),
  ).toBe("corgi");
  // Restart with the retry still loading: neither request was committed.
  f.mark("restart-with-pending-preparation");
  await f.quit();
  ({ app, pet } = await f.launch());
  settings = await openSettings(app, { run: f.run });
  expect(
    await f.run("character-switch:settings.inputValue", () =>
      settings.getByRole("combobox", { name: "角色" }).inputValue(),
    ),
  ).toBe("corgi");
  await expect
    .poll(() =>
      f.run("character-switch:paintedCharacter", () => paintedCharacter(pet)),
    )
    .toBe("corgi");
  f.mark("fresh-selection-with-cold-images");
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Mosey",
      )!.webContents;
      Reflect.set(globalThis, "freshPreparationImages", []);
      contents.session.webRequest.onBeforeRequest((details, callback) => {
        if (
          details.webContentsId === contents.id &&
          details.resourceType === "image"
        )
          Reflect.get(globalThis, "freshPreparationImages").push(callback);
        else callback({ cancel: false });
      });
    }),
  );
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("whale"),
  );
  await expect
    .poll(
      () =>
        f.run("character-switch:app.evaluate", () =>
          app.evaluate(
            () => Reflect.get(globalThis, "freshPreparationImages").length,
          ),
        ),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0);
  expect(
    await f.run("character-switch:paintedCharacter", () =>
      paintedCharacter(pet),
    ),
  ).toBe("corgi");
  expect(
    await f.run("character-switch:settings.textContent", () =>
      settings.locator("#character-status").textContent(),
    ),
  ).toContain("正在准备鲸鱼娘");
  // A cold atlas can legitimately take more than expect.poll's default 1s.
  // Hold it beyond that boundary, while retaining the application's finite
  // preparation deadline and every stale-reply/persistence assertion above.
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Mosey")!
        .webContents.session.webRequest.onBeforeRequest(null);
      for (const callback of Reflect.get(globalThis, "freshPreparationImages"))
        setTimeout(() => callback({ cancel: false }), 1400);
    }),
  );
  await expect
    .poll(
      () =>
        f.run("character-switch:paintedCharacter", () => paintedCharacter(pet)),
      { timeout: 15000 },
    )
    .toBe("whale");
  expect(
    await f.run("character-switch:settings.isVisible", () =>
      settings.locator("#character-error").isVisible(),
    ),
  ).toBe(false);
  f.mark("fresh-selection-painted");

  await f.quit();
  await f.close();
});

test.runIf(process.env.MOSEY_TEST_MODE === "development")(
  "a development document reload resumes an unfinished preparation",
  async () => {
    const f = await createPetTestSession({
      dock: "empty",
      preferences: {
        version: 3,
        character: "corgi",
        size: 160,
        visibility: "visible",
      },
    });

    const { app, pet } = await f.launch();
    const settings = await openSettings(app, { run: f.run });
    await f.run("character-switch:app.evaluate", () =>
      app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows().find(
          (window) => window.getTitle() === "Mosey",
        )!.webContents;
        Reflect.set(globalThis, "heldReloadImages", 0);
        contents.session.webRequest.onBeforeRequest((details, callback) => {
          if (
            details.webContentsId === contents.id &&
            details.resourceType === "image"
          ) {
            Reflect.set(
              globalThis,
              "heldReloadImages",
              Reflect.get(globalThis, "heldReloadImages") + 1,
            );
            return;
          }
          callback({ cancel: false });
        });
        // Only the old document loses its in-flight image responses. The new
        // document must prepare the selection through the ordinary handshake.
        contents.once("did-start-loading", () => {
          contents.session.webRequest.onBeforeRequest(null);
        });
      }),
    );
    await f.run("character-switch:settings.selectOption", () =>
      settings.getByRole("combobox", { name: "角色" }).selectOption("whale"),
    );
    await expect
      .poll(() =>
        f.run("character-switch:app.evaluate", () =>
          app.evaluate(() => Reflect.get(globalThis, "heldReloadImages")),
        ),
      )
      .toBeGreaterThan(0);
    await f.run("character-switch:pet.evaluate", () =>
      pet.evaluate(() => location.reload()),
    );
    await expect
      .poll(
        () =>
          f.run("character-switch:settings.inputValue", () =>
            settings.getByRole("combobox", { name: "角色" }).inputValue(),
          ),
        {
          timeout: 10000,
        },
      )
      .toBe("whale");
    await expect
      .poll(() =>
        f.run("character-switch:paintedCharacter", () => paintedCharacter(pet)),
      )
      .toBe("whale");
    expect(
      await f.run("character-switch:settings.isVisible", () =>
        settings.locator("#character-error").isVisible(),
      ),
    ).toBe(false);

    await f.quit();
    await f.close();
  },
);

test("a held and falling pet keeps its old character until landing, then uses the new painted hit mask", async () => {
  const f = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "whale",
      size: 160,
      visibility: "visible",
    },
  });

  const { app, pet } = await f.launch();
  const settings = await openSettings(app, { run: f.run });
  const bounds = () =>
    f.run("character-switch:app.evaluate", () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .getBounds(),
      ),
    );
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(({ BrowserWindow, screen }) => {
      const pet = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "Mosey",
      )!;
      const area = screen.getPrimaryDisplay().workArea;
      pet.setPosition(
        screen.getCursorScreenPoint().x > area.x + area.width / 2
          ? area.x
          : area.x + area.width - pet.getBounds().width,
        area.y + area.height - pet.getBounds().height,
        false,
      );
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const body = () =>
    f.run("character-switch:pet.evaluate", () =>
      pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const data = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        const y = Math.floor(canvas.height * 0.65);
        for (let radius = 0; radius < canvas.width / 2; radius++)
          for (const x of [
            Math.floor(canvas.width / 2) - radius,
            Math.floor(canvas.width / 2) + radius,
          ])
            if (data[(y * canvas.width + x) * 4 + 3]! >= 128)
              return { x: x / devicePixelRatio, y: y / devicePixelRatio };
        throw new Error("No painted pet body");
      }),
    );
  const oldMask = await f.run("character-switch:pet.evaluate", () =>
    pet.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const data = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let mask = "";
      for (let i = 3; i < data.length; i += 4)
        mask += data[i]! >= 128 ? "1" : "0";
      return mask;
    }),
  );
  const ground = await bounds();
  const point = await body();
  await f.run("character-switch:pet.move", () =>
    pet.mouse.move(point.x, point.y),
  );
  await f.run("character-switch:pet.down", () => pet.mouse.down());
  await f.run("character-switch:pet.move", () =>
    pet.mouse.move(point.x, point.y - 100, { steps: 4 }),
  );
  await expect.poll(async () => (await bounds()).y).toBeLessThan(ground.y - 50);
  await f.run("character-switch:settings.evaluate", () =>
    settings
      .getByRole("combobox", { name: "角色" })
      .evaluate((element: HTMLSelectElement) => {
        element.value = "corgi";
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }),
  );
  await expect
    .poll(
      () =>
        f.run("character-switch:settings.textContent", () =>
          settings.locator("#character-status").textContent(),
        ),
      {
        timeout: 10000,
      },
    )
    .toContain("等待宠物站稳");
  expect(
    await f.run("character-switch:pet.getAttribute", () =>
      pet.locator("canvas").getAttribute("aria-label"),
    ),
  ).toContain("鲸鱼娘");
  await f.run("character-switch:pet.up", () => pet.mouse.up());
  await expect
    .poll(
      () =>
        f.run("character-switch:pet.getAttribute", () =>
          pet.locator("canvas").getAttribute("aria-label"),
        ),
      {
        timeout: 5000,
      },
    )
    .toBe("柯基 · 待机");
  expect(await bounds()).toEqual(ground);
  expect(
    await f.run("character-switch:settings.inputValue", () =>
      settings.getByRole("combobox", { name: "角色" }).inputValue(),
    ),
  ).toBe("corgi");
  // The same directed input now grabs corgi pixels, proving that replacing
  // images also replaced main-process hit geometry without another window.
  await expect
    .poll(() =>
      f.run("character-switch:paintedCharacter", () => paintedCharacter(pet)),
    )
    .toBe("corgi");
  const next = await f.run("character-switch:pet.evaluate", () =>
    pet.evaluate((oldMask) => {
      const canvas = document.querySelector("canvas")!;
      const data = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      for (let y = 4; y < canvas.height - 4; y++)
        for (let x = 4; x < canvas.width - 4; x++) {
          const pixel = y * canvas.width + x;
          if (
            data[pixel * 4 + 3]! >= 240 &&
            oldMask[pixel] === "0" &&
            oldMask[pixel - 3] === "0" &&
            oldMask[pixel + 3] === "0"
          )
            return { x: x / devicePixelRatio, y: y / devicePixelRatio };
        }
      throw new Error("No new corgi-only painted hit region");
    }, oldMask),
  );
  await f.run("character-switch:pet.move", () =>
    pet.mouse.move(next.x, next.y),
  );
  await f.run("character-switch:pet.down", () => pet.mouse.down());
  await f.run("character-switch:pet.move", () =>
    pet.mouse.move(next.x, next.y - 60, { steps: 3 }),
  );
  await expect.poll(async () => (await bounds()).y).toBeLessThan(ground.y - 30);
  await f.run("character-switch:pet.up", () => pet.mouse.up());

  await f.quit();
  await f.close();
});

test("renderer recovery retires a pending preparation and permits an explicit retry without showing a hidden pet", async () => {
  const f = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      size: 160,
      visibility: "hidden",
    },
  });

  const { app, pet } = await f.launch();
  const settings = await openSettings(app, { run: f.run });
  await expect
    .poll(() =>
      f.run("character-switch:pet.getAttribute", () =>
        pet.locator("canvas").getAttribute("aria-label"),
      ),
    )
    .toBe("柯基 · 待机");
  const id = await f.run("character-switch:app.evaluate", () =>
    app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Mosey")!.id,
    ),
  );
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(({ session }, origin) => {
      Reflect.set(globalThis, "holdCharacterImages", true);
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        const allowed =
          url.protocol === "file:" ||
          url.protocol === "data:" ||
          url.origin === origin ||
          (url.protocol === "ws:" && url.host === new URL(origin).host);
        if (!allowed) return callback({ cancel: true });
        if (
          details.resourceType === "image" &&
          Reflect.get(globalThis, "holdCharacterImages")
        )
          return;
        callback({ cancel: false });
      });
    }, new URL(pet.url()).origin),
  );
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("whale"),
  );
  await expect
    .poll(() =>
      f.run("character-switch:settings.textContent", () =>
        settings.locator("#character-status").textContent(),
      ),
    )
    .toContain("正在准备");
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(({ BrowserWindow }) => {
      Reflect.set(globalThis, "holdCharacterImages", false);
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Mosey")!
        .webContents.forcefullyCrashRenderer();
    }),
  );
  await expect
    .poll(() =>
      f.run("character-switch:settings.textContent", () =>
        settings.locator("#character-error").textContent(),
      ),
    )
    .toContain("角色切换未完成");
  const actual = () =>
    f.run("character-switch:app.evaluate", () =>
      app.evaluate(async ({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        return {
          id: pet.id,
          visible: pet.isVisible(),
          label: await pet.webContents.executeJavaScript(
            'document.querySelector("canvas")?.getAttribute("aria-label")',
          ),
        };
      }),
    );
  await expect
    .poll(actual, { timeout: 10000 })
    .toEqual({ id, visible: false, label: "柯基 · 待机" });
  await f.run("character-switch:settings.click", () =>
    settings.getByRole("button", { name: "重试角色" }).click(),
  );
  await expect
    .poll(actual, { timeout: 10000 })
    .toEqual({ id, visible: false, label: "鲸鱼娘 · 待机" });

  await f.quit();
  await f.close();
});

test("walking switches preserve left facing and ground placement at both end sizes", async () => {
  for (const size of [70, 240]) {
    const f = await createPetTestSession({
      dock: "empty",
      behavior: { random: 0.1 },
      preferences: {
        version: 3,
        character: "whale",
        size,
        visibility: "hidden",
      },
    });

    const { app, pet } = await f.launch();
    const settings = await openSettings(app, { run: f.run });

    await f.run("character-switch:settings.click", () =>
      settings.getByRole("button", { name: "显示宠物", exact: true }).click(),
    );
    await advanceRest(app, 0.1, f.run);
    await expect
      .poll(() =>
        f.run("character-switch:pet.getAttribute", () =>
          pet.locator("canvas").getAttribute("aria-label"),
        ),
      )
      .toBe("鲸鱼娘 · 走路");
    const before = await f.run("character-switch:pet.evaluate", () =>
      pet.evaluate(() => window.mosey.getPresentation()),
    );
    expect(before.direction).toBe("left");
    const bounds = () =>
      f.run("character-switch:app.evaluate", () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.getTitle() === "Mosey")!
            .getBounds(),
        ),
      );
    const old = await bounds();
    await f.run("character-switch:settings.selectOption", () =>
      settings.getByRole("combobox", { name: "角色" }).selectOption("corgi"),
    );
    await expect
      .poll(
        () =>
          f.run("character-switch:pet.getAttribute", () =>
            pet.locator("canvas").getAttribute("aria-label"),
          ),
        {
          timeout: 5000,
        },
      )
      .toBe("柯基 · 待机");
    const next = await f.run("character-switch:pet.evaluate", () =>
      pet.evaluate(() => window.mosey.getPresentation()),
    );
    expect(next.direction).toBe("left");
    expect(next.size).toBe(size);
    const actual = await bounds();
    expect(actual.y + actual.height).toBe(old.y + old.height);
    expect(actual.width).toBe(size);
    // Preparation may take a few real walking frames; it cannot recenter the
    // pet. The saved placement remains within one ordinary walk's distance.
    expect(Math.abs(actual.x - old.x)).toBeLessThan(130);

    await f.quit();
    await f.close();
  }
});

test("a switch waits through climbing and commits on observed Dock support without descending", async () => {
  const f = await createPetTestSession({
    dock: "controlled",
    behavior: { random: 0.1 },
    preferences: {
      version: 3,
      character: "whale",
      size: 160,
      visibility: "visible",
    },
  });

  const { app, pet } = await f.launch();
  const settings = await openSettings(app, { run: f.run });
  await expect
    .poll(() =>
      f.run("character-switch:pet.getAttribute", () =>
        pet.locator("canvas").getAttribute("aria-label"),
      ),
    )
    .toBe("鲸鱼娘 · 待机");
  const native = () =>
    f.run("character-switch:app.evaluate", () =>
      app.evaluate(({ BrowserWindow, screen }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        return {
          id: pet.id,
          bounds: pet.getBounds(),
          display: screen.getPrimaryDisplay(),
        };
      }),
    );
  const old = await native();
  const floor = old.display.workArea.y + old.display.workArea.height;
  const top = floor - 80;
  // Hold only behavior time before presenting the Dock. Image preparation
  // retains its real 2000ms delay and unrelated deadline while motion waits.
  await f.run("character-switch:controlBehavior", () =>
    controlBehavior(app, { running: false }),
  );
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(({ BrowserWindow }) => {
      Reflect.set(globalThis, "climbDelayedImages", 0);
      const contents = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Mosey",
      )!.webContents;
      contents.session.webRequest.onBeforeRequest((details, callback) => {
        if (
          details.webContentsId === contents.id &&
          details.resourceType === "image"
        ) {
          Reflect.set(
            globalThis,
            "climbDelayedImages",
            Reflect.get(globalThis, "climbDelayedImages") + 1,
          );
          setTimeout(() => callback({ cancel: false }), 2000);
        } else callback({ cancel: false });
      });
    }),
  );
  await f.setDockObservation({
    orientation: "bottom",
    primaryDisplayID: old.display.id,
    bounds: {
      x: old.bounds.x,
      y: top,
      width: 160,
      height: old.display.bounds.y + old.display.bounds.height - top,
    },
    contour: Array.from({ length: 160 }, (_, i) => ({
      axis: old.bounds.x + i,
      inward: top,
    })),
  });
  await expect
    .poll(
      () =>
        f.run("character-switch:pet.getAttribute", () =>
          pet.locator("canvas").getAttribute("aria-label"),
        ),
      {
        timeout: 5000,
      },
    )
    .toBe("鲸鱼娘 · 攀爬");
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("corgi"),
  );
  await expect
    .poll(
      () =>
        f.run("character-switch:settings.textContent", () =>
          settings.locator("#character-status").textContent(),
        ),
      {
        timeout: 10000,
      },
    )
    .toContain("等待宠物站稳");
  expect(
    await f.run("character-switch:pet.getAttribute", () =>
      pet.locator("canvas").getAttribute("aria-label"),
    ),
  ).toBe("鲸鱼娘 · 攀爬");
  await f.run("character-switch:app.evaluate", () =>
    app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Mosey")!
        .webContents.session.webRequest.onBeforeRequest(null);
      if (Reflect.get(globalThis, "climbDelayedImages") < 1)
        throw new Error("Cold character preparation did not request an image");
    }),
  );
  await f.run("character-switch:controlBehavior", () =>
    controlBehavior(app, { running: true }),
  );
  await expect
    .poll(
      () =>
        f.run("character-switch:pet.getAttribute", () =>
          pet.locator("canvas").getAttribute("aria-label"),
        ),
      {
        timeout: 5000,
      },
    )
    .toBe("柯基 · 待机");
  const next = await native();
  expect(next.id).toBe(old.id);
  expect(next.bounds).toEqual({ ...old.bounds, y: top - old.bounds.height });
  await f.run("character-switch:settings.selectOption", () =>
    settings.getByRole("combobox", { name: "角色" }).selectOption("whale"),
  );
  await expect
    .poll(() =>
      f.run("character-switch:pet.getAttribute", () =>
        pet.locator("canvas").getAttribute("aria-label"),
      ),
    )
    .toBe("鲸鱼娘 · 待机");
  expect((await native()).bounds).toEqual(next.bounds);

  await f.quit();
  await f.close();
});
