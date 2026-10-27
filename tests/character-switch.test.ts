import { test, expect, afterAll } from "vitest";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startForge } from "./support/forge";
import { emptyDockCapture } from "./support/empty-dock";
import { openSettings } from "./support/settings";
const packaged = process.env.MOSEY_TEST_MODE === "packaged";
let stop: (() => Promise<void>) | undefined;
afterAll(async () => {
  await stop?.();
});
async function fixture(preferences?: unknown) {
  if (!packaged && !stop) stop = await startForge();
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-character-"));
  const profile = path.join(root, "profile");
  await mkdir(profile);
  if (preferences)
    await writeFile(
      path.join(profile, "preferences.json"),
      JSON.stringify(preferences),
    );
  if (packaged)
    execFileSync("/usr/bin/ditto", [
      path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
      path.join(root, "Mosey.app"),
    ]);
  const restoreDock = await emptyDockCapture(
    packaged
      ? path.join(root, "Mosey.app/Contents/Resources/native/dock-runtime")
      : path.resolve("build/native/dock-runtime"),
  );
  let app: ElectronApplication;
  const launch = async () => {
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [`--user-data-dir=${profile}`],
          }
        : { args: [".", `--user-data-dir=${profile}`] },
    );
    const pet = await app.firstWindow();
    await pet.locator("canvas").waitFor();
    // The HTML canvas exists before the renderer's asynchronous atlas decode.
    // Observe the public presentation even for hidden profiles; only visible
    // pets must have painted pixels before a scenario can sample or grab them.
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
        timeout: 15000,
      })
      .toMatch(/^(鲸鱼娘|柯基) · /);
    const visible = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Mosey")!
        .isVisible(),
    );
    if (visible)
      await expect
        .poll(() => paintedCharacter(pet), { timeout: 15000 })
        .toMatch(/^(whale|corgi)$/);
    return { app, pet };
  };
  return {
    root,
    profile,
    launch,
    async close() {
      await app?.close().catch(() => {});
      await restoreDock();
      await rm(root, { recursive: true, force: true });
    },
  };
}

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

test("new and legacy profiles choose whale while retaining size and hidden intent", async () => {
  for (const previous of [
    undefined,
    { version: 1, size: "large", visibility: "hidden" },
    { version: 2, size: 70, visibility: "hidden" },
  ]) {
    const f = await fixture(previous);
    try {
      const { app, pet } = await f.launch();
      const settings = await openSettings(app);
      await expect
        .poll(() =>
          settings.getByRole("combobox", { name: "角色" }).inputValue(),
        )
        .toBe("whale");
      await expect
        .poll(() => pet.locator("canvas").getAttribute("aria-label"))
        .toBe("鲸鱼娘 · 待机");
      const actual = await app.evaluate(({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        return { size: pet.getBounds().width, visible: pet.isVisible() };
      });
      expect(actual).toEqual({
        size: previous?.size === "large" ? 240 : (previous?.size ?? 160),
        visible: !previous,
      });
    } finally {
      await f.close();
    }
  }
});

test("selection replaces the one pet, retains hidden size and location, and survives reopen and restart", async () => {
  const f = await fixture({
    version: 3,
    character: "whale",
    size: 70,
    visibility: "hidden",
  });
  try {
    let { app, pet } = await f.launch();
    let settings = await openSettings(app);
    const native = () =>
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
      });
    const before = await native();
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("corgi");
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
        timeout: 10000,
      })
      .toBe("柯基 · 待机");
    expect(await native()).toEqual(before);
    await settings.close();
    settings = await openSettings(app);
    await expect
      .poll(() => settings.getByRole("combobox", { name: "角色" }).inputValue())
      .toBe("corgi");
    await app.close();
    ({ app, pet } = await f.launch());
    settings = await openSettings(app);
    await expect
      .poll(() => settings.getByRole("combobox", { name: "角色" }).inputValue())
      .toBe("corgi");
    expect((await native()).visible).toBe(false);
    expect((await native()).bounds.width).toBe(70);
    await settings
      .getByRole("button", { name: "显示宠物", exact: true })
      .click();
    await expect
      .poll(() =>
        pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          return Array.from(pixels).filter(
            (value, i) => i % 4 === 3 && value > 127,
          ).length;
        }),
      )
      .toBeGreaterThan(500);
  } finally {
    await f.close();
  }
});

test("failed persistence keeps the actual and saved character, and retries the failed target", async () => {
  const f = await fixture({
    version: 3,
    character: "whale",
    size: 160,
    visibility: "hidden",
  });
  try {
    let { app, pet } = await f.launch();
    let settings = await openSettings(app);
    const obstacle = path.join(f.profile, "preferences.json.tmp");
    await mkdir(obstacle);
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("corgi");
    await expect
      .poll(() => settings.locator("#character-error").textContent(), {
        timeout: 10000,
      })
      .toContain("保存失败");
    expect(await pet.locator("canvas").getAttribute("aria-label")).toBe(
      "鲸鱼娘 · 待机",
    );
    expect(
      await settings.getByRole("combobox", { name: "角色" }).inputValue(),
    ).toBe("whale");
    await settings.close();
    settings = await openSettings(app);
    expect(await settings.locator("#character-error").isVisible()).toBe(true);
    await rm(obstacle, { recursive: true });
    await settings.getByRole("button", { name: "重试角色" }).click();
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("柯基 · 待机");
    await app.close();
    ({ app, pet } = await f.launch());
    settings = await openSettings(app);
    await expect
      .poll(() => settings.getByRole("combobox", { name: "角色" }).inputValue())
      .toBe("corgi");
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("柯基 · 待机");
  } finally {
    await f.close();
  }
});

test("image failure and a superseded delayed response cannot replace the newest choice across settings lifetimes", async () => {
  const f = await fixture({
    version: 3,
    character: "corgi",
    size: 240,
    visibility: "visible",
  });
  try {
    let { app, pet } = await f.launch();
    let settings = await openSettings(app);
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("柯基 · 待机");
    await expect.poll(() => paintedCharacter(pet)).toBe("corgi");
    // Substitute only the image transport boundary, retaining the app's URL
    // allowlist. Delayed callbacks belong to the test's Electron session.
    await app.evaluate(({ session }, origin) => {
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
    }, new URL(pet.url()).origin);
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("whale");
    await expect
      .poll(() => settings.locator("#character-error").textContent(), {
        timeout: 10000,
      })
      .toContain("素材加载失败");
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("柯基 · 待机");
    expect(await paintedCharacter(pet)).toBe("corgi");
    await app.evaluate(() => {
      Reflect.get(globalThis, "imageTransport").mode = "hold";
    });
    await settings.getByRole("button", { name: "重试角色" }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => Reflect.get(globalThis, "imageTransport").callbacks.length,
        ),
      )
      .toBeGreaterThan(0);
    await settings.close();
    settings = await openSettings(app);
    await expect
      .poll(() => settings.locator("#character-status").textContent())
      .toContain("正在准备鲸鱼娘");
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("corgi");
    await app.evaluate(() => {
      const control = Reflect.get(globalThis, "imageTransport");
      control.mode = "allow";
      for (const callback of control.callbacks.splice(0))
        callback({ cancel: true });
    });
    await expect
      .poll(() => settings.locator("#character-status").textContent())
      .toBe("当前角色：柯基");
    // Let the obsolete decode rejection reach the real main process.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await settings.locator("#character-error").isVisible()).toBe(false);
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("柯基 · 待机");
    await app.close();
    ({ app, pet } = await f.launch());
    settings = await openSettings(app);
    await expect
      .poll(() => settings.getByRole("combobox", { name: "角色" }).inputValue())
      .toBe("corgi");
    await expect.poll(() => paintedCharacter(pet)).toBe("corgi");
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("whale");
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
        timeout: 10000,
      })
      .toBe("鲸鱼娘 · 待机");
    await expect.poll(() => paintedCharacter(pet)).toBe("whale");
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("corgi");
    await expect.poll(() => paintedCharacter(pet)).toBe("corgi");
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("whale");
    await expect.poll(() => paintedCharacter(pet)).toBe("whale");
    await settings
      .getByRole("combobox", { name: "角色" })
      .evaluate((element: HTMLSelectElement) => {
        for (const target of ["corgi", "whale", "whale"]) {
          element.value = target;
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await paintedCharacter(pet)).toBe("whale");
    expect(await settings.locator("#character-error").isVisible()).toBe(false);
    expect(await settings.locator("#character-status").textContent()).toBe(
      "当前角色：鲸鱼娘",
    );
  } finally {
    await f.close();
  }
});

test("a held and falling pet keeps its old character until landing, then uses the new painted hit mask", async () => {
  const f = await fixture({
    version: 3,
    character: "whale",
    size: 160,
    visibility: "visible",
  });
  try {
    const { app, pet } = await f.launch();
    const settings = await openSettings(app);
    const bounds = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .getBounds(),
      );
    await app.evaluate(({ BrowserWindow, screen }) => {
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
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const body = () =>
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
      });
    const oldMask = await pet.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const data = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let mask = "";
      for (let i = 3; i < data.length; i += 4)
        mask += data[i]! >= 128 ? "1" : "0";
      return mask;
    });
    const ground = await bounds();
    const point = await body();
    await pet.mouse.move(point.x, point.y);
    await pet.mouse.down();
    await pet.mouse.move(point.x, point.y - 100, { steps: 4 });
    await expect
      .poll(async () => (await bounds()).y)
      .toBeLessThan(ground.y - 50);
    await settings
      .getByRole("combobox", { name: "角色" })
      .evaluate((element: HTMLSelectElement) => {
        element.value = "corgi";
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await expect
      .poll(() => settings.locator("#character-status").textContent(), {
        timeout: 10000,
      })
      .toContain("等待宠物站稳");
    expect(await pet.locator("canvas").getAttribute("aria-label")).toContain(
      "鲸鱼娘",
    );
    await pet.mouse.up();
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
        timeout: 5000,
      })
      .toBe("柯基 · 待机");
    expect(await bounds()).toEqual(ground);
    expect(
      await settings.getByRole("combobox", { name: "角色" }).inputValue(),
    ).toBe("corgi");
    // The same directed input now grabs corgi pixels, proving that replacing
    // images also replaced main-process hit geometry without another window.
    await expect.poll(() => paintedCharacter(pet)).toBe("corgi");
    const next = await pet.evaluate((oldMask) => {
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
    }, oldMask);
    await pet.mouse.move(next.x, next.y);
    await pet.mouse.down();
    await pet.mouse.move(next.x, next.y - 60, { steps: 3 });
    await expect
      .poll(async () => (await bounds()).y)
      .toBeLessThan(ground.y - 30);
    await pet.mouse.up();
  } finally {
    await f.close();
  }
});

test("renderer recovery retires a pending preparation and permits an explicit retry without showing a hidden pet", async () => {
  const f = await fixture({
    version: 3,
    character: "corgi",
    size: 160,
    visibility: "hidden",
  });
  try {
    const { app, pet } = await f.launch();
    const settings = await openSettings(app);
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("柯基 · 待机");
    const id = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Mosey")!.id,
    );
    await app.evaluate(({ session }, origin) => {
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
    }, new URL(pet.url()).origin);
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("whale");
    await expect
      .poll(() => settings.locator("#character-status").textContent())
      .toContain("正在准备");
    await app.evaluate(({ BrowserWindow }) => {
      Reflect.set(globalThis, "holdCharacterImages", false);
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Mosey")!
        .webContents.forcefullyCrashRenderer();
    });
    await expect
      .poll(() => settings.locator("#character-error").textContent())
      .toContain("角色切换未完成");
    const actual = () =>
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
      });
    await expect
      .poll(actual, { timeout: 10000 })
      .toEqual({ id, visible: false, label: "柯基 · 待机" });
    await settings.getByRole("button", { name: "重试角色" }).click();
    await expect
      .poll(actual, { timeout: 10000 })
      .toEqual({ id, visible: false, label: "鲸鱼娘 · 待机" });
  } finally {
    await f.close();
  }
});

test("walking switches preserve left facing and ground placement at both end sizes", async () => {
  for (const size of [70, 240]) {
    const f = await fixture({
      version: 3,
      character: "whale",
      size,
      visibility: "hidden",
    });
    try {
      const { app, pet } = await f.launch();
      const settings = await openSettings(app);
      await app.evaluate(() => {
        Math.random = () => 0.1;
        const original = globalThis.setTimeout;
        Reflect.set(globalThis, "restoreRestClock", () => {
          globalThis.setTimeout = original;
        });
        globalThis.setTimeout = ((
          callback: (...args: unknown[]) => void,
          delay?: number,
          ...args: unknown[]
        ) =>
          original(
            callback,
            delay && delay >= 18000 ? 100 : delay,
            ...args,
          )) as typeof setTimeout;
      });
      await settings
        .getByRole("button", { name: "显示宠物", exact: true })
        .click();
      await expect
        .poll(() => pet.locator("canvas").getAttribute("aria-label"))
        .toBe("鲸鱼娘 · 走路");
      const before = await pet.evaluate(() => window.mosey.getPresentation());
      expect(before.direction).toBe("left");
      await app.evaluate(() => Reflect.get(globalThis, "restoreRestClock")());
      const bounds = () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.getTitle() === "Mosey")!
            .getBounds(),
        );
      const old = await bounds();
      await settings
        .getByRole("combobox", { name: "角色" })
        .selectOption("corgi");
      await expect
        .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
          timeout: 5000,
        })
        .toBe("柯基 · 待机");
      const next = await pet.evaluate(() => window.mosey.getPresentation());
      expect(next.direction).toBe("left");
      expect(next.size).toBe(size);
      const actual = await bounds();
      expect(actual.y + actual.height).toBe(old.y + old.height);
      expect(actual.width).toBe(size);
      // Preparation may take a few real walking frames; it cannot recenter the
      // pet. The saved placement remains within one ordinary walk's distance.
      expect(Math.abs(actual.x - old.x)).toBeLessThan(130);
    } finally {
      await f.close();
    }
  }
});

test("a switch waits through climbing and commits on observed Dock support without descending", async () => {
  const f = await fixture({
    version: 3,
    character: "whale",
    size: 160,
    visibility: "visible",
  });
  const observation = path.join(f.root, "dock.json");
  const helper = packaged
    ? path.join(f.root, "Mosey.app/Contents/Resources/native/dock-runtime")
    : path.resolve("build/native/dock-runtime");
  await writeFile(observation, "null");
  await writeFile(
    helper,
    `#!${process.execPath}\nimport fs from 'node:fs'; const started = performance.now(); let sequence=0; console.log(JSON.stringify({type:'environment',protocol:1,processID:process.pid,parentPID:process.ppid}));setInterval(()=>{const observation=JSON.parse(fs.readFileSync(${JSON.stringify(observation)},'utf8')); console.log(JSON.stringify({type:'observation',elapsed:(performance.now()-started)/1000,sequence:++sequence,sourceAgeSeconds:0,callbackAgeSeconds:0,idle:false,reason:observation?'current':'alpha_empty',observation}));},50);`,
  );
  await chmod(helper, 0o755);
  try {
    const { app, pet } = await f.launch();
    const settings = await openSettings(app);
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("鲸鱼娘 · 待机");
    const native = () =>
      app.evaluate(({ BrowserWindow, screen }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        return {
          id: pet.id,
          bounds: pet.getBounds(),
          display: screen.getPrimaryDisplay(),
        };
      });
    const old = await native();
    const floor = old.display.workArea.y + old.display.workArea.height;
    const top = floor - 80;
    // Hold time before presenting the Dock so slow UI observation cannot miss
    // the real climb. Images still prepare on real time; restore motion after
    // readiness without forcing behavior or position.
    await app.evaluate(({ BrowserWindow }) => {
      const now = Date.now;
      const heldAt = now();
      Date.now = () => heldAt;
      Reflect.set(globalThis, "restoreClimbClock", () => {
        Date.now = now;
      });
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
    });
    await writeFile(
      observation,
      JSON.stringify({
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
      }),
    );
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
        timeout: 5000,
      })
      .toBe("鲸鱼娘 · 攀爬");
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("corgi");
    await expect
      .poll(() => settings.locator("#character-status").textContent(), {
        timeout: 10000,
      })
      .toContain("等待宠物站稳");
    expect(await pet.locator("canvas").getAttribute("aria-label")).toBe(
      "鲸鱼娘 · 攀爬",
    );
    await app.evaluate(({ BrowserWindow }) => {
      Reflect.get(globalThis, "restoreClimbClock")();
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Mosey")!
        .webContents.session.webRequest.onBeforeRequest(null);
      if (Reflect.get(globalThis, "climbDelayedImages") < 1)
        throw new Error("Cold character preparation did not request an image");
    });
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
        timeout: 5000,
      })
      .toBe("柯基 · 待机");
    const next = await native();
    expect(next.id).toBe(old.id);
    expect(next.bounds).toEqual({ ...old.bounds, y: top - old.bounds.height });
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("whale");
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("鲸鱼娘 · 待机");
    expect((await native()).bounds).toEqual(next.bounds);
  } finally {
    await f.close();
  }
});
