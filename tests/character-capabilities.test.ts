import { expect, onTestFinished, test } from "vitest";
import { createPetTestSession } from "./support/pet-session";
import { openSettings } from "./support/settings";
import { writeCharacterFixture } from "./support/character-fixture";
import { distanceFromGround } from "./support/ground";
import { observeGeometry } from "./support/geometry-observer";
import { finishGeometryObservation } from "./support/geometry-observer-cleanup";
import type { ElectronApplication, Page } from "playwright";
import { evidencePath } from "./support/evidence";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

async function shortenRest(app: ElectronApplication) {
  await app.evaluate(() => {
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) =>
      timeout(
        callback,
        delay && delay >= 10000 ? 800 : delay,
        ...args,
      )) as typeof setTimeout;
    Math.random = () => 0.9;
  });
}

async function advanceAwakeTime(app: ElectronApplication, pet: Page) {
  await app.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 180000;
  });
  await pet.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 180000;
  });
}

async function paintedShape(pet: Page) {
  return pet.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const data = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let top = canvas.height,
      count = 0,
      red = 0,
      green = 0;
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (data[i + 3]! < 128) continue;
        top = Math.min(top, y);
        count++;
        red += data[i]!;
        green += data[i + 1]!;
      }
    return {
      top: top / devicePixelRatio,
      count,
      red: red / count,
      green: green / count,
      pixels: canvas.toDataURL(),
    };
  });
}

test("a five-action character is discovered and painted through the ordinary selector", async () => {
  const f = await createPetTestSession({ dock: "empty" });
  try {
    await writeCharacterFixture(f.profile);
    const { app, pet } = await f.launch();
    const settings = await openSettings(app);
    await expect
      .poll(() => settings.getByRole("option").allTextContents())
      .toContain("五动作角色");
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("minimal");
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("五动作角色 · 待机");
    await expect
      .poll(() =>
        pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          const data = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let magenta = 0;
          for (let i = 0; i < data.length; i += 4)
            if (
              data[i]! > 200 &&
              data[i + 1]! < 60 &&
              data[i + 2]! > 180 &&
              data[i + 3]! > 127
            )
              magenta++;
          return magenta;
        }),
      )
      .toBeGreaterThan(1000);
  } finally {
    await f.close();
  }
});

test("an incomplete sleep extension reports its missing poses and retains the current character", async () => {
  const f = await createPetTestSession({ dock: "empty" });
  try {
    await writeCharacterFixture(f.profile, { extra: ["sleeping"] });
    const { app, pet } = await f.launch();
    const settings = await openSettings(app);
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("minimal");
    await expect
      .poll(() => settings.locator("#character-error").textContent())
      .toContain("settling");
    expect(await settings.locator("#character-error").textContent()).toContain(
      "waking",
    );
    expect(await pet.locator("canvas").getAttribute("aria-label")).toBe(
      "DeepSeek · 待机",
    );
    expect(
      await settings.getByRole("combobox", { name: "角色" }).inputValue(),
    ).toBe("whale");
  } finally {
    await f.close();
  }
});

test("missing reactions and flutter keep clicks and drag-release on the five basic actions", async () => {
  const f = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "minimal",
      size: 240,
      visibility: "visible",
    },
  });
  await writeCharacterFixture(f.profile);
  const { app, pet } = await f.launch();
  // Pin the native observation so the only floor change in this scenario is
  // the one made while dragging, without a display-metrics notification.
  const workArea = await app.evaluateHandle(({ screen }) => {
    const readDisplay = screen.getPrimaryDisplay;
    const emit = screen.emit;
    const display = readDisplay.call(screen);
    const notifications: unknown[] = [];
    let heightDelta = 0;
    screen.getPrimaryDisplay = () => ({
      ...display,
      workArea: {
        ...display.workArea,
        height: display.workArea.height + heightDelta,
      },
    });
    // A real work-area-only notification contradicts this pinned observation.
    // Other display changes and lifecycle cancellation retain their real path.
    screen.emit = function (event, ...args) {
      if (
        event === "display-metrics-changed" &&
        args[1]?.id === display.id &&
        Array.isArray(args[2]) &&
        args[2].length === 1 &&
        args[2][0] === "workArea"
      ) {
        notifications.push({
          time: Date.now(),
          display: args[1],
          changedMetrics: args[2],
        });
        if (notifications.length > 20) notifications.shift();
        return false;
      }
      return Reflect.apply(emit, this, [event, ...args]);
    };
    return {
      notifications,
      changeHeight(delta: number) {
        heightDelta = delta;
      },
      restore() {
        screen.getPrimaryDisplay = readDisplay;
        screen.emit = emit;
      },
    };
  });
  onTestFinished(async () => {
    const evidence = await finishGeometryObservation({
      records: () => workArea.evaluate((control) => control.notifications),
      stop: () => workArea.evaluate((control) => control.restore()),
      dispose: () => workArea.dispose(),
    });
    await writeFile(
      evidencePath("minimal-work-area-notifications.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => {});
  });
  // Keep this isolated app (including its pinned display getter) alive for
  // failure evidence. The session's test-exit hook owns process cleanup.
  await observeGeometry(app, pet, "minimal-drag-release", { detailed: true });
  const label = () => pet.locator("canvas").getAttribute("aria-label");
  const bounds = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Mosey")!
        .getBounds(),
    );
  await pet.mouse.click(90, 180);
  await expect.poll(label).toBe("五动作角色 · 待机");
  // Move away from the physical cursor before targeted drag input.
  await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(
      (w) => w.getTitle() === "Mosey",
    )!;
    const area = screen.getPrimaryDisplay().workArea;
    const cursor = screen.getCursorScreenPoint();
    window.setPosition(
      cursor.x > area.x + area.width / 2 ? area.x : area.x + area.width - 240,
      window.getBounds().y,
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expect.poll(() => distanceFromGround(app)).toBe(0);
  const ground = await bounds();
  await pet.mouse.move(90, 180);
  await pet.mouse.down();
  await pet.mouse.move(90, 60, { steps: 4 });
  await expect.poll(label).toBe("五动作角色 · 拖拽");
  expect((await bounds()).y).toBeLessThan(ground.y - 80);
  await workArea.evaluate((control) => control.changeHeight(-1));
  await pet.mouse.up();
  await expect.poll(label, { interval: 20 }).toBe("五动作角色 · 下落");
  // Landing follows the live floor, even before a native metrics event.
  await expect.poll(() => distanceFromGround(app)).toBe(0);
  await expect.poll(() => bounds()).toEqual({ ...ground, y: ground.y - 1 });
  await expect.poll(label).toBe("五动作角色 · 待机");
});

test("a minimal character stays active past sleep time and does not climb a newly appearing Dock", async () => {
  const f = await createPetTestSession({ dock: "controlled" });
  try {
    await writeCharacterFixture(f.profile);
    const { app, pet } = await f.launch();
    const settings = await openSettings(app);
    await shortenRest(app);
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("minimal");
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("五动作角色 · 待机");
    const scene = await app.evaluate(({ BrowserWindow, screen }) => ({
      bounds: BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Mosey")!
        .getBounds(),
      display: screen.getPrimaryDisplay(),
    }));
    const area = scene.display.workArea;
    const edge = area.y + area.height - 70;
    await f.setDockObservation({
      orientation: "bottom",
      primaryDisplayID: scene.display.id,
      bounds: { x: area.x, y: edge, width: area.width, height: 70 },
      contour: Array.from({ length: Math.ceil(area.width / 4) }, (_, i) => ({
        axis: area.x + i * 4,
        inward: edge,
      })),
    });
    await advanceAwakeTime(app, pet);
    const frames = new Set<string>();
    const labels = new Set<string | null>();
    const positions: { x: number; y: number }[] = [];
    const until = Date.now() + 4400;
    while (Date.now() < until) {
      labels.add(await pet.locator("canvas").getAttribute("aria-label"));
      const shape = await paintedShape(pet);
      expect(shape.count).toBeGreaterThan(1000);
      frames.add(shape.pixels);
      positions.push(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.getTitle() === "Mosey")!
            .getBounds(),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    expect([...labels].sort()).toEqual(
      ["五动作角色 · 待机", "五动作角色 · 走路"].sort(),
    );
    expect(frames.size).toBeGreaterThan(1);
    expect(
      Math.max(...positions.map((p) => p.x)) -
        Math.min(...positions.map((p) => p.x)),
    ).toBeGreaterThan(30);
    expect(positions.every((p) => p.y === scene.bounds.y)).toBe(true);
    await pet.screenshot({
      path: evidencePath("minimal-character.png"),
      omitBackground: true,
    });
    await writeFile(
      evidencePath("minimal-character.json"),
      JSON.stringify({
        labels: [...labels],
        frames: frames.size,
        positions,
        note: "Prepared filesystem fixture; long rest timers shortened, clock advanced 180s, Dock producer controlled",
      }),
    );
  } finally {
    await f.close();
  }
});

test("a complete sleep extension animates, responds and wakes through its own poses", async () => {
  const f = await createPetTestSession({ dock: "empty" });
  try {
    await writeCharacterFixture(f.profile, {
      extra: ["settling", "sleeping", "ear", "waking"],
    });
    const { app, pet } = await f.launch();
    const settings = await openSettings(app);
    await settings.getByRole("button", { name: "大", exact: true }).click();
    await shortenRest(app);
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("minimal");
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("五动作角色 · 待机");
    await advanceAwakeTime(app, pet);
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
        timeout: 5000,
      })
      .toBe("五动作角色 · 睡觉");
    // A presentation can arrive before its first animation frame is painted.
    // Observe the actual sleeping silhouette before comparing breathing frames.
    await expect
      .poll(async () => (await paintedShape(pet)).top)
      .toBeGreaterThanOrEqual(190);
    const asleep = await paintedShape(pet);
    await expect
      .poll(async () => (await paintedShape(pet)).pixels)
      .not.toBe(asleep.pixels);
    await pet.mouse.click(100, 220);
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
        interval: 10,
      })
      .toBe("五动作角色 · 睡眠回应");
    await pet.mouse.click(100, 220);
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
        interval: 10,
      })
      .toBe("五动作角色 · 醒来");
    await expect
      .poll(async () => (await paintedShape(pet)).top)
      .toBeLessThan(150);
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
        interval: 20,
      })
      .toBe("五动作角色 · 待机");
  } finally {
    await f.close();
  }
});

test("same-identity versions keep pixels and hit regions together and ignore late preparation", async () => {
  const f = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "minimal",
      size: 240,
      visibility: "visible",
    },
  });
  try {
    await writeCharacterFixture(f.profile);
    let { app, pet } = await f.launch();
    let settings = await openSettings(app);
    const original = await pet.evaluate(() => window.mosey.getPresentation());
    await app.evaluate(({ session }) => {
      const transport = {
        hold: true,
        callbacks: [] as ((value: { cancel: boolean }) => void)[],
      };
      Reflect.set(globalThis, "versionTransport", transport);
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (details.resourceType === "image" && transport.hold)
          transport.callbacks.push(callback);
        else callback({ cancel: false });
      });
    });
    await writeCharacterFixture(f.profile, { color: [30, 40, 220], left: 180 });
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("minimal");
    await expect
      .poll(() =>
        app.evaluate(
          () => Reflect.get(globalThis, "versionTransport").callbacks.length,
        ),
      )
      .toBeGreaterThan(0);
    expect((await paintedShape(pet)).red).toBeGreaterThan(200);
    await writeCharacterFixture(f.profile, { color: [20, 220, 50], left: 300 });
    await app.evaluate(() => {
      Reflect.get(globalThis, "versionTransport").hold = false;
    });
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("minimal");
    await expect
      .poll(async () => (await paintedShape(pet)).green)
      .toBeGreaterThan(200);
    const updated = await pet.evaluate(() => window.mosey.getPresentation());
    expect(updated.resourceVersion).not.toBe(original.resourceVersion);
    await app.evaluate(() => {
      for (const callback of Reflect.get(
        globalThis,
        "versionTransport",
      ).callbacks.splice(0))
        callback({ cancel: false });
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await paintedShape(pet)).green).toBeGreaterThan(200);
    expect(
      (await pet.evaluate(() => window.mosey.getPresentation()))
        .resourceVersion,
    ).toBe(updated.resourceVersion);

    await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "Mosey",
      )!;
      const area = screen.getPrimaryDisplay().workArea;
      const cursor = screen.getCursorScreenPoint();
      window.setPosition(
        cursor.x > area.x + area.width / 2 ? area.x : area.x + area.width - 240,
        window.getBounds().y,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const bounds = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .getBounds(),
      );
    const ground = await bounds();
    await pet.mouse.move(90, 180);
    await pet.mouse.down();
    await pet.mouse.move(90, 80, { steps: 4 });
    await pet.mouse.up();
    expect(await bounds()).toEqual(ground);
    await pet.mouse.move(180, 180);
    await pet.mouse.down();
    await pet.mouse.move(180, 80, { steps: 4 });
    await expect
      .poll(async () => (await bounds()).y)
      .toBeLessThan(ground.y - 60);
    await pet.mouse.up();
    await expect.poll(() => bounds()).toEqual(ground);
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("五动作角色 · 待机");
    await pet.screenshot({
      path: evidencePath("updated-character.png"),
      omitBackground: true,
    });
    await writeFile(
      evidencePath("character-resource-versions.json"),
      JSON.stringify({
        before: original.resourceVersion,
        after: updated.resourceVersion,
        oldHit: [90, 180],
        newHit: [180, 180],
      }),
    );
    ({ app, pet } = await f.restart());
    settings = await openSettings(app);
    expect(
      await settings.getByRole("combobox", { name: "角色" }).inputValue(),
    ).toBe("minimal");
    expect((await paintedShape(pet)).green).toBeGreaterThan(200);
    expect(
      (await pet.evaluate(() => window.mosey.getPresentation()))
        .resourceVersion,
    ).toBe(updated.resourceVersion);
  } finally {
    await f.close();
  }
});

test("invalid basic animation playback is rejected before replacing the pet", async () => {
  const f = await createPetTestSession({ dock: "empty" });
  try {
    const directory = await writeCharacterFixture(f.profile);
    const file = path.join(directory, "character.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.atlases.find(
      (atlas: { action: string }) => atlas.action === "landing",
    ).loop = "repeat";
    await writeFile(file, JSON.stringify(manifest));
    const { app, pet } = await f.launch();
    const settings = await openSettings(app);
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("minimal");
    await expect
      .poll(() => settings.locator("#character-error").textContent())
      .toContain("landing");
    expect(await pet.locator("canvas").getAttribute("aria-label")).toBe(
      "DeepSeek · 待机",
    );
  } finally {
    await f.close();
  }
});

test("a failed same-identity update retains the visible name and pixels until retry commits", async () => {
  const f = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "minimal",
      size: 240,
      visibility: "visible",
    },
  });
  try {
    await writeCharacterFixture(f.profile);
    const { app, pet } = await f.launch();
    const settings = await openSettings(app);
    await writeCharacterFixture(f.profile, {
      name: "更新后的角色",
      color: [20, 220, 50],
    });
    const obstacle = path.join(f.profile, "preferences.json.tmp");
    await mkdir(obstacle);
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("minimal");
    await expect
      .poll(() => settings.locator("#character-error").textContent())
      .toContain("保存失败");
    expect(await settings.locator("#character-status").textContent()).toBe(
      "当前角色：五动作角色",
    );
    expect(await pet.locator("canvas").getAttribute("aria-label")).toBe(
      "五动作角色 · 待机",
    );
    expect((await paintedShape(pet)).red).toBeGreaterThan(200);
    await rm(obstacle, { recursive: true });
    await settings.getByRole("button", { name: "重试角色" }).click();
    await expect
      .poll(() => pet.locator("canvas").getAttribute("aria-label"))
      .toBe("更新后的角色 · 待机");
    // Each window renders independently; the pet's label does not acknowledge
    // the settings window's final notification.
    await expect
      .poll(() => settings.locator("#character-status").textContent())
      .toBe("当前角色：更新后的角色");
    await expect
      .poll(async () => (await paintedShape(pet)).green)
      .toBeGreaterThan(200);
  } finally {
    await f.close();
  }
});
