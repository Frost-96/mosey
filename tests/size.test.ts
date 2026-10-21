import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startForge } from "./support/forge";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

test("size menu scales the visible corgi and keeps its feet on the same ground", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-size-"));
  let app: ElectronApplication | undefined;
  let stopForge: (() => Promise<void>) | undefined;
  try {
    if (!packaged) stopForge = await startForge();
    if (packaged)
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    const args = [
      `--user-data-dir=${path.join(root, "profile")}`,
      `--force-device-scale-factor=${process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"}`,
    ];
    const launch = () =>
      electron.launch(
        packaged
          ? {
              executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
              args,
            }
          : { args: [".", ...args] },
      );
    app = await launch();
    let pet = await app.firstWindow();
    const bounds = () =>
      app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBounds(),
      );
    // Temporary native-boundary diagnostics for the CI-only one-DIP drift.
    await app.evaluate(({ BrowserWindow, screen }) => {
      const pet = BrowserWindow.getAllWindows()[0]!;
      const samples: unknown[] = [];
      const sample = (event: string, requested?: unknown) => {
        const display = screen.getPrimaryDisplay();
        samples.push({
          event,
          requested,
          at: Date.now(),
          bounds: pet.getBounds(),
          visible: pet.isVisible(),
          workArea: display.workArea,
          displayBounds: display.bounds,
          scaleFactor: display.scaleFactor,
        });
      };
      Reflect.set(globalThis, "sizeNativeEvidence", samples);
      sample("initial");
      pet.on("show", () => sample("show"));
      pet.on("resize", () => sample("resize"));
      pet.on("move", () => sample("move"));
      pet.on("ready-to-show", () => sample("ready-to-show"));
      screen.on("display-metrics-changed", () =>
        sample("display-metrics-changed"),
      );
      const setBounds = pet.setBounds.bind(pet);
      pet.setBounds = (bounds, animate) => {
        sample("setBounds-before", bounds);
        setBounds(bounds, animate);
        sample("setBounds-after", bounds);
      };
      const setPosition = pet.setPosition.bind(pet);
      pet.setPosition = (x, y, animate) => {
        sample("setPosition-before", { x, y });
        setPosition(x, y, animate);
        sample("setPosition-after", { x, y });
      };
    });
    const initial = await bounds();
    const choose = (label: string) =>
      app!.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "Mosey")
          ?.submenu?.items.find((item) => item.label === "Size")
          ?.submenu?.items.find((item) => item.label === label);
        if (!item) throw new Error(`Missing size menu item: ${label}`);
        item.click();
      }, label);
    const invoke = (label: string) =>
      app!.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "Mosey")
          ?.submenu?.items.find((item) => item.label === label);
        if (!item) throw new Error(`Missing menu item: ${label}`);
        item.click();
      }, label);
    const pixels = () =>
      pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL();
      });
    for (const [label, side] of [
      ["Small", 180],
      ["Large", 300],
      ["Medium", 240],
    ] as const) {
      await choose(label);
      await expect.poll(async () => (await bounds()).width).toBe(side);
      const resized = await bounds();
      expect(resized.height).toBe(side);
      expect(resized.x + side / 2).toBe(initial.x + initial.width / 2);
      expect(resized.y + side).toBe(initial.y + initial.height);
      await expect
        .poll(() =>
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
              bottom: Math.round((bottom + 1) / devicePixelRatio),
              visible: opaque > 2000,
            };
          }),
        )
        .toEqual({ width: side, bottom: side, visible: true });
      await pet.screenshot({
        path: `test-results/${packaged ? "packaged" : "development"}-size-${label.toLowerCase()}-${process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"}x.png`,
        omitBackground: true,
      });
      const idle = new Set<string>();
      const until = Date.now() + 2150;
      while (Date.now() < until) {
        idle.add(await pixels());
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      // Directed input proves application geometry, not real OS click routing.
      await pet.mouse.click(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(idle.has(await pixels()), `${label} transparent corner`).toBe(
        true,
      );
      for (const target of ["body", "edge"] as const) {
        const point = await pet.evaluate(
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
        );
        await pet.mouse.click(point.x, point.y);
        await expect
          .poll(async () => idle.has(await pixels()), { interval: 20 })
          .toBe(false);
        await expect
          .poll(async () => idle.has(await pixels()), { timeout: 5000 })
          .toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // Keep the directed gesture away from real cursor movement, as #4 does.
      await app.evaluate(({ BrowserWindow, screen }) => {
        const pet = BrowserWindow.getAllWindows()[0]!;
        const area = screen.getPrimaryDisplay().workArea;
        const pointer = screen.getCursorScreenPoint();
        pet.setPosition(
          pointer.x > area.x + area.width / 2
            ? area.x
            : area.x + area.width - pet.getBounds().width,
          pet.getBounds().y,
          false,
        );
      });
      const ground = await bounds();
      await pet.mouse.move(side / 2, side * 0.75);
      await pet.mouse.down();
      await pet.mouse.move(side / 2, -120, { steps: 5 });
      await expect
        .poll(async () => (await bounds()).y)
        .toBeLessThan(ground.y - 150);
      await pet.mouse.up();
      await expect
        .poll(async () => (await bounds()).y, { interval: 10 })
        .toBeGreaterThan(ground.y - 150);
      // Catch the moving body using its visible pixels, including the scaled pose.
      const point = await pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        for (let y = Math.floor(canvas.height * 0.7); y < canvas.height; y++)
          for (let x = Math.floor(canvas.width * 0.45); x < canvas.width; x++)
            if (pixels[(y * canvas.width + x) * 4 + 3] > 250)
              return { x: x / devicePixelRatio, y: y / devicePixelRatio };
        throw new Error("No visible returning body");
      });
      await pet.mouse.move(point.x, point.y);
      await pet.mouse.down();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const caught = await bounds();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await bounds()).toEqual(caught);
      await pet.mouse.up();
      await expect.poll(async () => (await bounds()).y).toBe(ground.y);
      await expect
        .poll(async () => idle.has(await pixels()), { timeout: 5000 })
        .toBe(true);
      // Restore center for the next size's anchor assertion.
      await app.evaluate(
        ({ BrowserWindow }, initial) =>
          BrowserWindow.getAllWindows()[0]!.setPosition(
            initial.x +
              (initial.width -
                BrowserWindow.getAllWindows()[0]!.getBounds().width) /
                2,
            BrowserWindow.getAllWindows()[0]!.getBounds().y,
            false,
          ),
        initial,
      );
    }
    // Resize a captured pet in the air: preserve the physical foot, release the
    // old capture, and let the return finish with the new ground geometry.
    await pet.mouse.move(120, 180);
    await pet.mouse.down();
    await pet.mouse.move(120, 30, { steps: 5 });
    await expect
      .poll(async () => (await bounds()).y)
      .toBeLessThan(initial.y - 100);
    const held = await bounds();
    await choose("Large");
    const resizedHeld = await bounds();
    expect(resizedHeld.x + resizedHeld.width / 2).toBe(held.x + held.width / 2);
    expect(resizedHeld.y + resizedHeld.height).toBe(held.y + held.height);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await pet.mouse.move(-500, -500);
    await pet.mouse.up();
    expect(await bounds()).toEqual(resizedHeld);
    await expect
      .poll(async () => (await bounds()).y, { timeout: 3000, interval: 10 })
      .toBeGreaterThan(resizedHeld.y + 10);
    const falling = await bounds();
    await choose("Small");
    const resizedFalling = await bounds();
    expect(resizedFalling.x + resizedFalling.width / 2).toBe(
      falling.x + falling.width / 2,
    );
    expect(
      Math.abs(
        resizedFalling.y + resizedFalling.height - falling.y - falling.height,
      ),
    ).toBeLessThan(30);
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 4000,
      })
      .toBe(initial.y + initial.height);
    // A size write while hidden must retain hidden intent across restart.
    await invoke("Hide Mosey");
    await choose("Large");
    await app.close();
    app = await launch();
    pet = await app.firstWindow();
    expect((await bounds()).width).toBe(300);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isVisible(),
      ),
    ).toBe(false);
    await invoke("Show Mosey");
    const stable = await bounds();
    expect(stable.y + stable.height).toBe(initial.y + initial.height);
    await app.close();
    app = undefined;
    const profile = path.join(root, "profile");
    // The previous validated choice survives interrupted and corrupt primary writes.
    await writeFile(path.join(profile, "preferences.json"), "broken");
    await writeFile(path.join(profile, "preferences.json.tmp"), '{"version":1');
    app = await launch();
    pet = await app.firstWindow();
    expect((await bounds()).width).toBe(300);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isVisible(),
      ),
    ).toBe(false);
    await invoke("Show Mosey");
    await app.close();
    app = undefined;
    await rm(path.join(profile, "preferences.json"));
    await mkdir(path.join(profile, "preferences.json"));
    app = await launch();
    pet = await app.firstWindow();
    await choose("Small");
    expect((await bounds()).width).toBe(300);
    expect(
      await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "Mosey")
          ?.submenu?.items.find((item) => item.label === "Size")
          ?.submenu?.items.filter((item) => item.checked)
          .map((item) => item.label),
      ),
    ).toEqual(["Large"]);
    const logPath = await app.evaluate(({ app }) =>
      process
        .getBuiltinModule("node:path")
        .join(app.getPath("logs"), "main.log"),
    );
    expect(await readFile(logPath, "utf8")).toContain(
      "Unable to save pet size",
    );
  } catch (error) {
    await mkdir("test-results", { recursive: true });
    const evidence = await app
      ?.evaluate(() => Reflect.get(globalThis, "sizeNativeEvidence"))
      .catch(() => undefined);
    if (evidence) {
      console.error("[DEBUG-size-native]", JSON.stringify(evidence));
      await writeFile(
        `test-results/${packaged ? "packaged" : "development"}-size-native.json`,
        JSON.stringify(evidence, null, 2),
      );
    }
    await app
      ?.windows()[0]
      ?.screenshot({
        path: `test-results/failure-${packaged ? "packaged" : "development"}-size.png`,
        timeout: 3000,
      })
      .catch(() => {});
    throw error;
  } finally {
    await app?.close().catch(() => {});
    await stopForge?.();
    await rm(root, { recursive: true, force: true });
  }
});
