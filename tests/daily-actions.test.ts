import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import type { ElectronApplication, Page } from "playwright";
import type { Menu } from "electron";
import {
  dailyActionDefinitions,
  type DailyAction,
} from "../src/shared/character-capabilities";
import type { Presentation } from "../src/shared/contract";
import { createPetTestSession } from "./support/pet-session";
import { openSettings, closeSettings } from "./support/settings";
import { distanceFromGround } from "./support/ground";
import { evidencePath } from "./support/evidence";
import { matchPaintedFrames } from "./support/pixels";

const oneShots = [
  "looking",
  "yawning",
  "petted",
  "grooming",
  "celebrating",
  "habit",
] as const;
const visibleLabels = [
  "张望",
  "坐下休息",
  "站起来",
  "打哈欠",
  "摸摸头",
  "整理仪容",
  "庆祝",
  "小习惯",
];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const presentation = (pet: Page) =>
  pet.evaluate(() => window.mosey.getPresentation());
const waitPosture = (
  pet: Page,
  posture: Presentation["posture"],
  timeout = 8000,
) =>
  expect
    .poll(async () => (await presentation(pet)).posture, {
      timeout,
      interval: 20,
    })
    .toBe(posture);

async function pixels(pet: Page) {
  return pet.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL();
  });
}

async function body(pet: Page) {
  return pet.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const { data, width, height } = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height);
    // Pick a solid interior block so thin hair/wing edges do not disappear
    // between the observed frame and the directed pointer event.
    for (let y = Math.floor(height * 0.5); y < height * 0.8; y += 2)
      for (let x = Math.floor(width * 0.4); x < width * 0.6; x += 2) {
        let solid = true;
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++)
            if (data[((y + dy) * width + x + dx) * 4 + 3]! < 220) solid = false;
        if (solid) return { x: x / devicePixelRatio, y: y / devicePixelRatio };
      }
    throw new Error("No solid painted body for daily-action input");
  });
}

async function moveAwayFromPointer(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow, screen }) => {
    const pet = BrowserWindow.getAllWindows().find(
      (w) => w.getTitle() === "Mosey",
    )!;
    const area = screen.getPrimaryDisplay().workArea;
    pet.setPosition(
      screen.getCursorScreenPoint().x > area.x + area.width / 2
        ? area.x
        : area.x + area.width - pet.getBounds().width,
      pet.getBounds().y,
      false,
    );
  });
  await pause(120);
}

async function nativeActions(app: ElectronApplication, pet: Page) {
  // Exercise the real body input, menu template and item callbacks. Only OS
  // tracking is substituted, as in context-menu.test; no behavior test hook.
  await app.evaluate(({ Menu }) => {
    Reflect.set(globalThis, "dailyMenus", []);
    Menu.prototype.popup = function (options) {
      Reflect.get(globalThis, "dailyMenus").push(this);
      Reflect.set(this, "dailyClose", options?.callback);
      this.emit("menu-will-show");
    };
    Menu.prototype.closePopup = function () {
      const callback = Reflect.get(this, "dailyClose");
      Reflect.set(this, "dailyClose", undefined);
      this.emit("menu-will-close");
      callback?.();
    };
  });
  const open = async () => {
    const count = await app.evaluate(
      () => Reflect.get(globalThis, "dailyMenus").length,
    );
    const point = await body(pet);
    await pet.mouse.move(point.x, point.y);
    await pet.mouse.down({ button: "right" });
    await expect
      .poll(() =>
        app.evaluate(() => Reflect.get(globalThis, "dailyMenus").length),
      )
      .toBe(count + 1);
    return app.evaluate(() => {
      const menu = Reflect.get(globalThis, "dailyMenus").at(-1) as Menu;
      const daily = menu.getMenuItemById("daily-actions");
      return (
        daily?.submenu?.items.map((item) => ({
          id: item.id,
          label: item.label,
          enabled: item.enabled,
        })) ?? []
      );
    });
  };
  const close = async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const menu = Reflect.get(globalThis, "dailyMenus").at(-1) as Menu;
      menu.closePopup(
        BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Mosey"),
      );
    });
    await pet.mouse.up({ button: "right" });
  };
  const choose = async (action: DailyAction) => {
    const items = await open();
    expect(
      items.find((item) => item.id === `daily-action-${action}`)?.enabled,
    ).toBe(true);
    await app.evaluate((_electron, action) => {
      const menu = Reflect.get(globalThis, "dailyMenus").at(-1) as Menu;
      const item = menu.getMenuItemById(`daily-action-${action}`);
      if (!item?.enabled)
        throw new Error(`Unavailable daily action: ${action}`);
      item.click();
    }, action);
    await close();
  };
  return { open, close, choose };
}

async function referenceFrames(pet: Page, action: Presentation["posture"]) {
  return pet.evaluate(async (action) => {
    const assets = await window.mosey.getCharacter();
    const p = await window.mosey.getPresentation();
    const atlas = assets.atlases.find((a) => a.action === action);
    if (!atlas) throw new Error(`No prepared ${action} atlas`);
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = assets.images[atlas.image]!;
    await image.decode();
    const side = p.size,
      scale = side / 240 / atlas.pixelRatio;
    return atlas.frames.map((frame) => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(side * devicePixelRatio);
      canvas.height = canvas.width;
      const c = canvas.getContext("2d")!;
      c.scale(devicePixelRatio, devicePixelRatio);
      const left = p.direction === "left";
      const x = side / 2 - frame.foot.x * scale;
      c.transform(
        left ? -scale : scale,
        0,
        0,
        scale,
        left ? side - x : x,
        side - frame.foot.y * scale,
      );
      const r = frame.region;
      c.drawImage(image, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
      c.getImageData(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL();
    });
  }, action);
}

async function captureTransitions(pet: Page) {
  await pet.evaluate(async () => {
    Reflect.set(window, "dailyTransitions", []);
    Reflect.set(
      window,
      "dailyPreviousPresentation",
      await window.mosey.getPresentation(),
    );
    window.mosey.onPresentation((p) => {
      const values = Reflect.get(window, "dailyTransitions") as Presentation[];
      const previous = Reflect.get(
        window,
        "dailyPreviousPresentation",
      ) as Presentation;
      if (previous.posture !== p.posture || previous.character !== p.character)
        values.push(p);
      Reflect.set(window, "dailyPreviousPresentation", p);
    });
  });
}
const transitions = (pet: Page) =>
  pet.evaluate(() => Reflect.get(window, "dailyTransitions") as Presentation[]);
async function clearTransitions(pet: Page) {
  await pet.evaluate(() => Reflect.set(window, "dailyTransitions", []));
}

test.each([
  ["whale", "DeepSeek"],
  ["claude", "Claude"],
  ["gemini", "Gemini"],
  ["gpt", "GPT"],
] as const)(
  "%s plays every daily menu action with its own pixels and completes seated rest",
  async (id, name) => {
    const session = await createPetTestSession({
      dock: "empty",
      preferences: {
        version: 3,
        character: id,
        size: 240,
        visibility: "visible",
      },
    });
    try {
      const { app, pet } = await session.launch();
      const errors: string[] = [];
      pet.on("pageerror", (error) => errors.push(error.message));
      await moveAwayFromPointer(app);
      const menu = await nativeActions(app, pet);
      await captureTransitions(pet);
      const items = await menu.open();
      expect(items.map((item) => item.label)).toEqual(visibleLabels);
      expect(items.map((item) => item.id)).toEqual(
        dailyActionDefinitions.map((item) => `daily-action-${item.action}`),
      );
      expect(
        items.find((item) => item.id === "daily-action-standingup")?.enabled,
      ).toBe(false);
      await menu.close();
      const evidence: {
        action: string;
        paintedFrames: number;
        postures: string[];
      }[] = [];
      for (const action of oneShots) {
        const expected = matchPaintedFrames(await referenceFrames(pet, action));
        await clearTransitions(pet);
        await menu.choose(action);
        await waitPosture(pet, action);
        const painted = new Set<string>();
        const deadline = Date.now() + 6500;
        while (Date.now() < deadline) {
          const p = await presentation(pet);
          if (p.posture === "resting") break;
          expect(p.posture).toBe(action);
          const frame = await pixels(pet);
          if (expected(frame)) painted.add(frame);
          await pause(35);
        }
        await waitPosture(pet, "resting");
        expect(painted.size).toBeGreaterThan(1);
        await expect
          .poll(() => pet.locator("canvas").getAttribute("aria-label"))
          .toBe(`${name} · 待机`);
        expect(await distanceFromGround(app)).toBe(0);
        evidence.push({
          action,
          paintedFrames: painted.size,
          postures: (await transitions(pet)).map((p) => p.posture),
        });
      }
      await clearTransitions(pet);
      await menu.choose("sitting");
      await waitPosture(pet, "sittingdown");
      await waitPosture(pet, "sitting");
      await expect
        .poll(() => pet.locator("canvas").getAttribute("aria-label"))
        .toBe(`${name} · 坐着休息`);
      const sittingFrames = matchPaintedFrames(
        await referenceFrames(pet, "sitting"),
      );
      await expect
        .poll(async () => sittingFrames(await pixels(pet)))
        .toBe(true);
      const seatedItems = await menu.open();
      expect(
        seatedItems.find((item) => item.id === "daily-action-standingup")
          ?.enabled,
      ).toBe(true);
      await menu.close();
      await waitPosture(pet, "standingup", 11000);
      await waitPosture(pet, "resting");
      expect((await transitions(pet)).map((p) => p.posture)).toEqual([
        "sittingdown",
        "sitting",
        "standingup",
        "resting",
      ]);
      expect(await distanceFromGround(app)).toBe(0);
      await writeFile(
        evidencePath(`daily-actions-${id}.json`),
        JSON.stringify(
          {
            menu: items,
            oneShots: evidence,
            seated: await transitions(pet),
            errors,
          },
          null,
          2,
        ),
      );
      expect(errors).toEqual([]);
    } finally {
      await session.close();
    }
  },
);

test("daily seated actions survive menu pause, queued commands, dragging, hiding and character replacement", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "gpt",
      size: 240,
      visibility: "visible",
    },
  });
  try {
    const { app, pet } = await session.launch();
    const errors: string[] = [];
    pet.on("pageerror", (error) => errors.push(error.message));
    await moveAwayFromPointer(app);
    const menu = await nativeActions(app, pet);
    await captureTransitions(pet);
    await app.evaluate(() =>
      Reflect.set(globalThis, "dailyOriginalRandom", Math.random),
    );
    const clickResponses: string[] = [];
    for (const [choice, action] of [
      [0.125, "tilt"],
      [0.375, "paw"],
      [0.625, "belly"],
      [0.875, "petted"],
    ] as const) {
      await app.evaluate((_electron, choice) => {
        Math.random = () => choice;
      }, choice);
      const expected = matchPaintedFrames(await referenceFrames(pet, action));
      const point = await body(pet);
      await pet.mouse.click(point.x, point.y);
      await waitPosture(pet, action);
      await expect
        .poll(async () => expected(await pixels(pet)), { interval: 20 })
        .toBe(true);
      clickResponses.push((await presentation(pet)).posture);
      await waitPosture(pet, "resting");
    }
    expect(clickResponses).toEqual(["tilt", "paw", "belly", "petted"]);
    await app.evaluate(() => {
      Math.random = Reflect.get(globalThis, "dailyOriginalRandom");
    });
    await menu.choose("sitting");
    await waitPosture(pet, "sitting");
    await menu.open();
    await expect
      .poll(async () => (await presentation(pet)).frozenAt)
      .not.toBeUndefined();
    await pause(50);
    const frozen = await pixels(pet),
      sittingId = (await presentation(pet)).actionId;
    await pause(350);
    expect(await pixels(pet)).toBe(frozen);
    expect((await presentation(pet)).actionId).toBe(sittingId);
    await menu.close();
    await expect
      .poll(async () => (await presentation(pet)).frozenAt)
      .toBeUndefined();
    await clearTransitions(pet);
    await menu.choose("grooming");
    await waitPosture(pet, "standingup");
    await waitPosture(pet, "grooming");
    await waitPosture(pet, "resting");
    expect((await transitions(pet)).map((p) => p.posture)).toEqual([
      "standingup",
      "grooming",
      "resting",
    ]);

    await menu.choose("sitting");
    await waitPosture(pet, "sitting");
    await menu.choose("standingup");
    await waitPosture(pet, "standingup");
    await waitPosture(pet, "resting");
    await menu.choose("sitting");
    await waitPosture(pet, "sitting");
    await clearTransitions(pet);
    const point = await body(pet);
    await pet.mouse.move(point.x, point.y);
    await pet.mouse.down();
    await pet.mouse.move(point.x, point.y - 100, { steps: 4 });
    await waitPosture(pet, "dragging");
    await pet.mouse.up();
    await waitPosture(pet, "resting", 12000);
    expect((await transitions(pet)).map((p) => p.posture)).toEqual(
      expect.arrayContaining(["dragging", "falling", "landing", "resting"]),
    );
    expect(await distanceFromGround(app)).toBe(0);

    await menu.choose("celebrating");
    await waitPosture(pet, "celebrating");
    const invokeVisibility = (label: string) =>
      app.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "Mosey")
          ?.submenu?.items.find((item) => item.label === label);
        if (!item) throw new Error(`Missing visibility command ${label}`);
        item.click();
      }, label);
    await invokeVisibility("Hide Mosey");
    await expect
      .poll(async () => (await presentation(pet)).visibility)
      .toBe("hidden");
    await pause(250);
    await invokeVisibility("Show Mosey");
    await waitPosture(pet, "resting");

    await menu.choose("sitting");
    await waitPosture(pet, "sitting");
    const before = await presentation(pet);
    const settings = await openSettings(app);
    await settings
      .getByRole("combobox", { name: "角色" })
      .selectOption("gemini");
    await expect
      .poll(async () => (await presentation(pet)).character)
      .toBe("gemini");
    await closeSettings(app);
    await waitPosture(pet, "resting");
    const current = await presentation(pet);
    expect(current.resourceVersion).not.toBe(before.resourceVersion);
    const geminiIdle = matchPaintedFrames(
      await referenceFrames(pet, "resting"),
    );
    await expect.poll(async () => geminiIdle(await pixels(pet))).toBe(true);
    await pause(400);
    expect((await presentation(pet)).character).toBe("gemini");
    expect((await presentation(pet)).posture).toBe("resting");
    expect(geminiIdle(await pixels(pet))).toBe(true);
    expect(errors).toEqual([]);
    await writeFile(
      evidencePath("daily-action-interruptions.json"),
      JSON.stringify(
        {
          before,
          current,
          clickResponses,
          transitions: await transitions(pet),
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await session.close();
  }
});

test("Corgi keeps its original menu without daily-action commands", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      size: 240,
      visibility: "visible",
    },
  });
  try {
    const { app, pet } = await session.launch();
    await moveAwayFromPointer(app);
    const menu = await nativeActions(app, pet);
    expect(await menu.open()).toEqual([]);
    const ids = await app.evaluate(() => {
      const menu = Reflect.get(globalThis, "dailyMenus").at(-1) as Menu;
      return menu.items.map((item) => item.id);
    });
    expect(ids).not.toContain("daily-actions");
    await menu.close();
    const assets = await pet.evaluate(() => window.mosey.getCharacter());
    expect(assets.atlases).toHaveLength(16);
    expect(
      dailyActionDefinitions.some((item) =>
        assets.atlases.some((atlas) => atlas.action === item.action),
      ),
    ).toBe(false);
    expect(await pet.locator("canvas").getAttribute("aria-label")).toBe(
      "柯基 · 待机",
    );
  } finally {
    await session.close();
  }
});

test("a newly raised Dock lets seated rest stand before moving onto support", async () => {
  const session = await createPetTestSession({
    dock: "controlled",
    preferences: {
      version: 3,
      character: "gpt",
      size: 240,
      visibility: "visible",
    },
  });
  try {
    const { app, pet } = await session.launch();
    await moveAwayFromPointer(app);
    const menu = await nativeActions(app, pet);
    await captureTransitions(pet);
    await menu.choose("sitting");
    await waitPosture(pet, "sitting");
    const native = () =>
      app.evaluate(({ BrowserWindow, screen }) => ({
        bounds: BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .getBounds(),
        display: screen.getPrimaryDisplay(),
      }));
    const before = await native();
    const top = before.bounds.y + before.bounds.height - 70;
    await clearTransitions(pet);
    await session.setDockObservation({
      orientation: "bottom",
      primaryDisplayID: before.display.id,
      bounds: {
        x: before.bounds.x,
        y: top,
        width: before.bounds.width,
        height: before.display.bounds.y + before.display.bounds.height - top,
      },
      contour: Array.from({ length: before.bounds.width }, (_, index) => ({
        axis: before.bounds.x + index,
        inward: top,
      })),
    });
    await waitPosture(pet, "standingup");
    const samples = [];
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const first = await presentation(pet);
      if (first.posture !== "standingup") break;
      const observed = await native();
      const last = await presentation(pet);
      if (last.posture === "standingup" && last.actionId === first.actionId) {
        samples.push(observed.bounds);
        expect(observed.bounds).toEqual(before.bounds);
      }
      await pause(30);
    }
    expect(samples.length).toBeGreaterThan(0);
    await waitPosture(pet, "resting", 12000);
    const events = (await transitions(pet)).map((p) => p.posture);
    expect(events).toEqual(["standingup", "climbing", "landing", "resting"]);
    expect((await native()).bounds).toEqual({
      ...before.bounds,
      y: top - before.bounds.height,
    });
    await writeFile(
      evidencePath("daily-seated-dock.json"),
      JSON.stringify(
        {
          before,
          top,
          standingSamples: samples,
          events,
          after: await native(),
        },
        null,
        2,
      ),
    );
  } finally {
    await session.close();
  }
});

test("free activity selects and paints all five daily behaviors without action commands", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "gpt",
      size: 240,
      visibility: "visible",
    },
  });
  try {
    const { app, pet } = await session.launch();
    await moveAwayFromPointer(app);
    await captureTransitions(pet);
    const choices = [
      [0.58, "looking"],
      [0.73, "sittingdown"],
      [0.83, "yawning"],
      [0.895, "grooming"],
      [0.965, "habit"],
    ] as const;
    const expected = new Map<
      Presentation["posture"],
      ReturnType<typeof matchPaintedFrames>
    >();
    for (const [, action] of choices)
      expected.set(
        action,
        matchPaintedFrames(await referenceFrames(pet, action)),
      );
    const idleCycle = await pet.evaluate(async () =>
      (await window.mosey.getCharacter()).atlases
        .find((atlas) => atlas.action === "resting")!
        .frames.reduce((sum, frame) => sum + frame.durationMs, 0),
    );
    // Substitute only the external rest wait, including its neutral alignment.
    // Pose playback, acknowledgements and the seated dwell keep their real time.
    await app.evaluate((_electron, maxRestWait) => {
      const timeout = globalThis.setTimeout;
      globalThis.setTimeout = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        timeout(
          callback,
          delay !== undefined && delay >= 18000 && delay <= maxRestWait
            ? 500
            : delay,
          ...args,
        )) as typeof setTimeout;
    }, 32000 + idleCycle);
    const evidence: { choice: number; action: string; events: string[] }[] = [];
    for (const [choice, action] of choices) {
      await app.evaluate((_electron, choice) => {
        Math.random = () => choice;
      }, choice);
      await clearTransitions(pet);
      for (const label of ["Hide Mosey", "Show Mosey"])
        await app.evaluate(({ Menu }, label) => {
          const item = Menu.getApplicationMenu()
            ?.items.find((entry) => entry.label === "Mosey")
            ?.submenu?.items.find((entry) => entry.label === label);
          if (!item) throw new Error(`Missing visibility item ${label}`);
          item.click();
        }, label);
      await waitPosture(pet, action, 4000);
      await expect
        .poll(async () => expected.get(action)!(await pixels(pet)), {
          interval: 20,
        })
        .toBe(true);
      if (action === "sittingdown") {
        await waitPosture(pet, "sitting");
        await waitPosture(pet, "standingup", 11000);
      }
      await waitPosture(pet, "resting");
      const events = (await transitions(pet)).map((p) => p.posture);
      expect(events).toEqual(
        action === "sittingdown"
          ? ["sittingdown", "sitting", "standingup", "resting"]
          : [action, "resting"],
      );
      expect(await distanceFromGround(app)).toBe(0);
      evidence.push({ choice, action, events });
    }
    await writeFile(
      evidencePath("daily-autonomy.json"),
      JSON.stringify(
        { timer: "Only rest waits shortened to 500ms", evidence },
        null,
        2,
      ),
    );
  } finally {
    await session.close();
  }
});

test("a playing reaction finishes before the last requested daily action starts", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "gpt",
      size: 240,
      visibility: "visible",
    },
  });
  try {
    const { app, pet } = await session.launch();
    await moveAwayFromPointer(app);
    const menu = await nativeActions(app, pet);
    await captureTransitions(pet);
    const bellyPixels = matchPaintedFrames(await referenceFrames(pet, "belly"));
    const groomingPixels = matchPaintedFrames(
      await referenceFrames(pet, "grooming"),
    );
    await app.evaluate(() => {
      Math.random = () => 0.625;
    });
    const point = await body(pet);
    await pet.mouse.click(point.x, point.y);
    await waitPosture(pet, "belly");
    await pause(250);
    const reaction = await presentation(pet);
    expect(reaction.posture).toBe("belly");
    expect(bellyPixels(await pixels(pet))).toBe(true);
    await menu.choose("looking");
    let queued = await presentation(pet);
    expect(queued.posture).toBe("belly");
    expect(queued.actionId).toBe(reaction.actionId);
    await menu.choose("grooming");
    queued = await presentation(pet);
    expect(queued.posture).toBe("belly");
    expect(queued.actionId).toBe(reaction.actionId);
    expect(bellyPixels(await pixels(pet))).toBe(true);
    // Completion must come from real renderer playback; the test never sends
    // DONE and the superseded looking request must never be presented.
    await waitPosture(pet, "grooming");
    const requested = await presentation(pet);
    expect(requested.actionId).toBeGreaterThan(reaction.actionId);
    await expect
      .poll(async () => groomingPixels(await pixels(pet)), { interval: 20 })
      .toBe(true);
    await waitPosture(pet, "resting");
    const events = await transitions(pet);
    expect(events.map((p) => p.posture)).toEqual([
      "belly",
      "grooming",
      "resting",
    ]);
    await writeFile(
      evidencePath("daily-queued-command.json"),
      JSON.stringify({ reaction, requested, events }, null, 2),
    );
  } finally {
    await session.close();
  }
});
