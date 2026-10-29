import { test, expect } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { chooseSize, openSettings } from "./support/settings";
import { createPetTestSession } from "./support/pet-session";

test("size menu scales the visible corgi and keeps its feet on the same ground", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: {
      version: 3,
      character: "corgi",
      size: 160,
      visibility: "visible",
    },
  });
  let { app, pet } = await session.launch();
  const profile = session.profile;
  const bounds = () =>
    session.run("app-evaluate", () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .getBounds(),
      ),
    );
  const desktop = () =>
    session.run("app-evaluate", () =>
      app.evaluate(({ BrowserWindow, screen }) => ({
        bounds: BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .getBounds(),
        area: screen.getPrimaryDisplay().workArea,
      })),
    );
  const groundDistance = async () => {
    const { bounds, area } = await desktop();
    return bounds.y + bounds.height - area.y - area.height;
  };
  await session.run("pet-waitForLoadState", () => pet.waitForLoadState("load"));
  await expect
    .poll(
      () =>
        session.run("pet-evaluate", () =>
          pet.evaluate(() => {
            const canvas = document.querySelector("canvas")!;
            return Array.from(
              canvas
                .getContext("2d")!
                .getImageData(0, 0, canvas.width, canvas.height).data,
            ).filter((value, i) => i % 4 === 3 && value > 127).length;
          }),
        ),
      { timeout: 10000 },
    )
    .toBeGreaterThan(1500);
  await expect
    .poll(() =>
      session.run("app-evaluate", () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.getTitle() === "Mosey")!
            .isVisible(),
        ),
      ),
    )
    .toBe(true);
  // Native visibility can precede the bounded work-area reconciliation.
  // Require actual startup settlement, still with strict zero distance.
  await expect.poll(groundDistance, { timeout: 3000, interval: 20 }).toBe(0);
  const choose = (label: string) =>
    chooseSize(app, label, { run: session.run });
  const invoke = (label: string) =>
    session.run("app-evaluate", () =>
      app.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "Mosey")
          ?.submenu?.items.find((item) => item.label === label);
        if (!item) throw new Error(`Missing menu item: ${label}`);
        item.click();
      }, label),
    );
  const pixels = () =>
    session.run("pet-evaluate", () =>
      pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL();
      }),
    );
  for (const [label, side] of [
    ["Small", 70],
    ["Large", 240],
    ["Medium", 160],
  ] as const) {
    const before = await desktop();
    await choose(label);
    await expect.poll(async () => (await bounds()).width).toBe(side);
    const after = await desktop();
    const resized = after.bounds;
    expect(resized.height).toBe(side);
    // A display-metrics change legitimately re-grounds the pet. Preserve
    // its physical foot on size-only changes; always use the current floor.
    if (JSON.stringify(before.area) === JSON.stringify(after.area)) {
      expect(resized.x + side / 2).toBe(
        before.bounds.x + before.bounds.width / 2,
      );
      expect(resized.y + side).toBe(before.bounds.y + before.bounds.height);
    }
    expect(resized.y + side).toBe(after.area.y + after.area.height);
    await expect
      .poll(() =>
        session.run("pet-evaluate", () =>
          pet.evaluate(() => {
            const canvas = document.querySelector("canvas")!;
            const data = canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height).data;
            let bottom = -1,
              opaque = 0;
            for (let y = 0; y < canvas.height; y++)
              for (let x = 0; x < canvas.width; x++)
                if (data[(y * canvas.width + x) * 4 + 3] > 127) {
                  bottom = y;
                  opaque++;
                }
            return {
              width: canvas.getBoundingClientRect().width,
              height: canvas.getBoundingClientRect().height,
              ratio: devicePixelRatio,
              backingWidth: canvas.width,
              backingHeight: canvas.height,
              bottom: Math.round((bottom + 1) / devicePixelRatio),
              visible: opaque > 200,
            };
          }),
        ),
      )
      .toEqual({
        width: side,
        height: side,
        ratio: Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
        backingWidth: side * Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
        backingHeight:
          side * Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
        bottom: side,
        visible: true,
      });
    await session.run("pet-screenshot", () =>
      pet.screenshot({
        path: path.join(
          session.evidence,
          `size-${label.toLowerCase()}-${process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"}x.png`,
        ),
        omitBackground: true,
      }),
    );
    const idle = new Set<string>();
    const until = Date.now() + 2150;
    while (Date.now() < until) {
      idle.add(await pixels());
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    // Directed input proves application geometry, not real OS click routing.
    await session.run("pet-click", () => pet.mouse.click(0, 0));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(idle.has(await pixels()), `${label} transparent corner`).toBe(true);
    for (const target of ["body", "edge"] as const) {
      const point = await session.run("pet-evaluate", () =>
        pet.evaluate(
          ({ side, target }) => {
            const canvas = document.querySelector("canvas")!;
            const pixels = canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height).data;
            if (target === "body") return { x: side / 2, y: side * 0.75 };
            const y = Math.floor(side * 0.75 * devicePixelRatio);
            for (let x = 0; x < canvas.width; x++)
              if (pixels[(y * canvas.width + x) * 4 + 3] > 250)
                return { x: x / devicePixelRatio + 3, y: side * 0.75 };
            throw new Error("No visible body edge");
          },
          { side, target },
        ),
      );
      await session.run("pet-click", () => pet.mouse.click(point.x, point.y));
      await expect
        .poll(async () => idle.has(await pixels()), { interval: 20 })
        .toBe(false);
      await expect
        .poll(async () => idle.has(await pixels()), { timeout: 5000 })
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Keep the directed gesture away from real cursor movement, as #4 does.
    await session.run("app-evaluate", () =>
      app.evaluate(({ BrowserWindow, screen }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        const area = screen.getPrimaryDisplay().workArea;
        const pointer = screen.getCursorScreenPoint();
        pet.setPosition(
          pointer.x > area.x + area.width / 2
            ? area.x
            : area.x + area.width - pet.getBounds().width,
          pet.getBounds().y,
          false,
        );
      }),
    );
    const ground = await bounds();
    await session.run("pet-move", () => pet.mouse.move(side / 2, side * 0.75));
    await session.run("pet-down", () => pet.mouse.down());
    await session.run("pet-move", () =>
      pet.mouse.move(side / 2, -120, { steps: 5 }),
    );
    await expect
      .poll(async () => (await bounds()).y)
      .toBeLessThan(ground.y - 150);
    await session.run("pet-up", () => pet.mouse.up());
    await expect
      .poll(async () => (await bounds()).y, { interval: 10 })
      .toBeGreaterThan(ground.y - 150);
    // Catch the moving body using its visible pixels, including the scaled pose.
    const point = await session.run("pet-evaluate", () =>
      pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        for (let y = Math.floor(canvas.height * 0.7); y < canvas.height; y++)
          for (let x = Math.floor(canvas.width * 0.45); x < canvas.width; x++)
            if (pixels[(y * canvas.width + x) * 4 + 3] > 250)
              return { x: x / devicePixelRatio, y: y / devicePixelRatio };
        throw new Error("No visible returning body");
      }),
    );
    await session.run("pet-move", () => pet.mouse.move(point.x, point.y));
    await session.run("pet-down", () => pet.mouse.down());
    await new Promise((resolve) => setTimeout(resolve, 60));
    const caught = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await bounds()).toEqual(caught);
    await session.run("pet-up", () => pet.mouse.up());
    await expect.poll(groundDistance).toBe(0);
    await expect
      .poll(async () => idle.has(await pixels()), { timeout: 5000 })
      .toBe(true);
    // Place the next size fixture at the current primary work-area center.
    await session.run("app-evaluate", () =>
      app.evaluate(({ BrowserWindow, screen }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        const bounds = pet.getBounds();
        const area = screen.getPrimaryDisplay().workArea;
        pet.setPosition(
          area.x + Math.round((area.width - bounds.width) / 2),
          bounds.y,
          false,
        );
      }),
    );
  }
  // Resize a captured pet in the air: preserve the physical foot, release the
  // old capture, and let the return finish with the new ground geometry.
  const beforeLift = await bounds();
  await session.run("pet-move", () => pet.mouse.move(80, 120));
  await session.run("pet-down", () => pet.mouse.down());
  // One client-space move makes one 150-DIP screen-space displacement.
  // Interpolated client moves would compound as the native window follows,
  // reaching the work-area ceiling on smaller CI displays.
  await session.run("pet-move", () => pet.mouse.move(80, -30));
  await expect
    .poll(async () => (await bounds()).y)
    .toBeLessThan(beforeLift.y - 100);
  const held = await bounds();
  await choose("Large");
  const resizedHeld = await bounds();
  expect(resizedHeld.x + resizedHeld.width / 2).toBe(held.x + held.width / 2);
  expect(resizedHeld.y + resizedHeld.height).toBe(held.y + held.height);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await session.run("pet-move", () => pet.mouse.move(-500, -500));
  await session.run("pet-up", () => pet.mouse.up());
  expect(await bounds()).toEqual(resizedHeld);
  await expect
    .poll(async () => (await bounds()).y, { timeout: 3000, interval: 10 })
    .toBeGreaterThan(resizedHeld.y + 10);
  // Include driver delay without counting ongoing falling as a resize jump.
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Measure the resize itself in one main-process turn. Separate driver
  // round trips include legitimate falling motion under scheduler load.
  const { before: falling, after: resizedFalling } = await choose("Small");
  expect(resizedFalling.width).toBe(70);
  expect(resizedFalling.x + resizedFalling.width / 2).toBe(
    falling.x + falling.width / 2,
  );
  expect(
    Math.abs(
      resizedFalling.y + resizedFalling.height - falling.y - falling.height,
    ),
  ).toBeLessThan(30);
  await expect.poll(groundDistance, { timeout: 4000 }).toBe(0);
  // A size write while hidden must retain hidden intent across restart.
  await invoke("Hide Mosey");
  await choose("Large");
  await session.quit();
  ({ app, pet } = await session.launch());
  expect((await bounds()).width).toBe(240);
  expect(
    await session.run("app-evaluate", () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .isVisible(),
      ),
    ),
  ).toBe(false);
  await invoke("Show Mosey");
  await expect
    .poll(
      () =>
        session.run("pet-evaluate", () =>
          pet.evaluate(() => {
            const canvas = document.querySelector("canvas")!;
            return Array.from(
              canvas
                .getContext("2d")!
                .getImageData(0, 0, canvas.width, canvas.height).data,
            ).filter((value, i) => i % 4 === 3 && value > 127).length;
          }),
        ),
      { timeout: 10000 },
    )
    .toBeGreaterThan(1500);
  // Restart must recompute the current primary floor; its work area may
  // legitimately differ from the previous process by even one desktop point.
  const { bounds: stable, area: restoredArea } = await desktop();
  expect(stable.y + stable.height).toBe(restoredArea.y + restoredArea.height);
  await session.quit();
  // The previous validated choice survives interrupted and corrupt primary writes.
  await session.run("writeFile", () =>
    writeFile(path.join(profile, "preferences.json"), "broken"),
  );
  await session.run("writeFile", () =>
    writeFile(path.join(profile, "preferences.json.tmp"), '{"version":1'),
  );
  ({ app, pet } = await session.launch());
  expect((await bounds()).width).toBe(240);
  expect(
    await session.run("app-evaluate", () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .isVisible(),
      ),
    ),
  ).toBe(false);
  await invoke("Show Mosey");
  await session.quit();
  await session.run("rm", () => rm(path.join(profile, "preferences.json")));
  await session.run("mkdir", () =>
    mkdir(path.join(profile, "preferences.json")),
  );
  ({ app, pet } = await session.launch());
  await choose("Small");
  expect((await bounds()).width).toBe(240);
  const settings = await openSettings(app, { run: session.run });
  expect(
    await session.run("settings-getAttribute", () =>
      settings
        .getByRole("button", { name: "大", exact: true })
        .getAttribute("aria-pressed"),
    ),
  ).toBe("true");
  const logPath = await session.run("app-evaluate", () =>
    app.evaluate(({ app }) =>
      process
        .getBuiltinModule("node:path")
        .join(app.getPath("logs"), "main.log"),
    ),
  );
  expect(
    await session.run("readFile", () => readFile(logPath, "utf8")),
  ).toContain("Unable to save pet size");
});
