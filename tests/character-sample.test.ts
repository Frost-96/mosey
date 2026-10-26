import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { startForge } from "./support/forge";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

test("isolated whale sample paints one blue character, walks on the ground and preserves visibility and size", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-whale-sample-"));
  let app: ElectronApplication | undefined;
  let stopForge: (() => Promise<void>) | undefined;
  await mkdir("test-results", { recursive: true });
  try {
    await mkdir(path.join(root, "profile"));
    await writeFile(
      path.join(root, "profile/preferences.json"),
      JSON.stringify({ version: 2, size: 160, visibility: "visible" }),
    );
    if (!packaged) stopForge = await startForge();
    else
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    const args = [
      "--character-sample=whale",
      `--user-data-dir=${root}/profile`,
      "--force-device-scale-factor=1",
    ];
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args,
            ...(process.env.MOSEY_RECORD_SAMPLE === "1"
              ? {
                  recordVideo: {
                    dir: "test-results/whale-video",
                    size: { width: 240, height: 240 },
                    fps: 60,
                  },
                }
              : {}),
          }
        : {
            args: [".", ...args],
            ...(process.env.MOSEY_RECORD_SAMPLE === "1"
              ? {
                  recordVideo: {
                    dir: "test-results/whale-video",
                    size: { width: 240, height: 240 },
                    fps: 60,
                  },
                }
              : {}),
          },
    );
    const pet = await app.firstWindow();
    const errors: string[] = [];
    pet.on("pageerror", (error) => errors.push(error.message));
    await pet.locator("canvas").waitFor();
    const painted = () =>
      pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const data = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let blue = 0,
          opaque = 0;
        for (let i = 0; i < data.length; i += 4)
          if (data[i + 3]! >= 128) {
            opaque++;
            if (data[i + 2]! > data[i]! * 1.2 && data[i + 2]! > data[i + 1]!)
              blue++;
          }
        return { blue, opaque, pixels: canvas.toDataURL() };
      });
    await expect
      .poll(async () => (await painted()).blue, { timeout: 10000 })
      .toBeGreaterThan(600);
    const windowState = () =>
      app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          bounds: window.getBounds(),
          visible: window.isVisible(),
        })),
      );
    expect(await windowState()).toHaveLength(1);
    const idle = new Set<string>();
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      idle.add((await painted()).pixels);
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
    expect(idle.size).toBeGreaterThan(1);
    await pet.screenshot({
      path: `test-results/${packaged ? "packaged" : "development"}-whale-idle.png`,
      omitBackground: true,
    });
    const menu = (label: string) =>
      app!.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((entry) => entry.label === "Mosey")
          ?.submenu?.items.find((entry) => entry.label === label);
        if (!item) throw new Error(`Missing menu item: ${label}`);
        item.click();
      }, label);
    // Only shorten the external rest clock; animation and desktop movement stay real-time.
    await app.evaluate(() => {
      Math.random = () => 0.1;
      const timeout = globalThis.setTimeout;
      globalThis.setTimeout = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        timeout(
          callback,
          delay && delay >= 10000 ? 500 : delay,
          ...args,
        )) as typeof setTimeout;
    });
    await menu("Hide Mosey");
    await expect
      .poll(async () => (await windowState())[0]!.visible)
      .toBe(false);
    await menu("Show Mosey");
    await expect.poll(async () => (await windowState())[0]!.visible).toBe(true);
    const origin = (await windowState())[0]!.bounds;
    await expect
      .poll(
        async () => Math.abs((await windowState())[0]!.bounds.x - origin.x),
        { timeout: 5000, interval: 30 },
      )
      .toBeGreaterThan(15);
    const moving = (await windowState())[0]!.bounds;
    expect(moving.y).toBe(origin.y);
    expect(moving.width).toBe(160);
    expect(idle.has((await painted()).pixels)).toBe(false);
    await pet.screenshot({
      path: `test-results/${packaged ? "packaged" : "development"}-whale-walking.png`,
      omitBackground: true,
    });
    if (process.env.MOSEY_RECORD_SAMPLE === "1") {
      const frames = [];
      const began = performance.now();
      while (performance.now() - began < 3000) {
        const [windows, pixels] = await Promise.all([windowState(), painted()]);
        frames.push({
          at: performance.now() - began,
          bounds: windows[0]!.bounds,
          pixels: pixels.pixels,
        });
        await new Promise((resolve) => setTimeout(resolve, 33));
      }
      await writeFile(
        `test-results/${packaged ? "packaged" : "development"}-whale-recording.json`,
        JSON.stringify({
          scope:
            "Real Electron canvas and native window bounds sampled at recorded elapsed times; not a desktop screen recording.",
          frames,
        }),
      );
    }
    // Directed input checks that hit geometry follows the painted whale. Actual
    // cross-application pointer routing remains a separate desktop acceptance.
    const body = await pet.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const data = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      const y = Math.floor(canvas.height * 0.55);
      for (let radius = 0; radius < canvas.width / 2; radius++) {
        for (const x of [
          Math.floor(canvas.width / 2) - radius,
          Math.floor(canvas.width / 2) + radius,
        ])
          if (data[(y * canvas.width + x) * 4 + 3]! >= 128) return { x, y };
      }
      throw new Error("No visible body at the sampled row");
    });
    await pet.mouse.move(body.x, body.y);
    await pet.mouse.down();
    const held = (await windowState())[0]!.bounds;
    await pet.mouse.move(body.x, body.y - 30, { steps: 3 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await windowState())[0]!.bounds).toEqual(held);
    await pet.mouse.up();
    for (const [label, size] of [
      ["Small", 70],
      ["Large", 240],
    ] as const) {
      await app.evaluate(({ Menu }, label) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((entry) => entry.label === "Mosey")
          ?.submenu?.items.find((entry) => entry.label === "Pet Size")
          ?.submenu?.items.find((entry) => entry.label === label);
        if (!item) throw new Error(`Missing size: ${label}`);
        item.click();
      }, label);
      await expect
        .poll(async () => (await windowState())[0]!.bounds.width)
        .toBe(size);
      await expect
        .poll(async () => (await painted()).blue)
        .toBeGreaterThan(size === 70 ? 100 : 1000);
      expect(await windowState()).toHaveLength(1);
      await pet.screenshot({
        path: `test-results/${packaged ? "packaged" : "development"}-whale-${size}.png`,
        omitBackground: true,
      });
    }
    expect(errors).toEqual([]);
  } finally {
    await app?.close().catch(() => {});
    await stopForge?.();
    await rm(root, { recursive: true, force: true });
  }
});
