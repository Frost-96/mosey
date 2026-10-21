import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { startForge } from "./support/forge";
import { PNG } from "pngjs";

// A source PNG scaled then mirrored by Canvas can differ from mirroring the
// already-resampled Canvas at a few alpha contour pixels. Compare silhouettes
// with a one-backing-pixel contour limit and <=1/3000 canvas pixels changed.
// Opposite-facing actual-render references below are a required negative control.
const silhouettes = new Map<
  string,
  { width: number; height: number; mask: Uint8Array }
>();
function silhouette(url: string) {
  let value = silhouettes.get(url);
  if (!value) {
    const png = PNG.sync.read(Buffer.from(url.split(",")[1]!, "base64"));
    const mask = new Uint8Array(png.width * png.height);
    for (let i = 0; i < mask.length; i++)
      mask[i] = png.data[i * 4 + 3] > 127 ? 1 : 0;
    value = { width: png.width, height: png.height, mask };
    silhouettes.set(url, value);
  }
  return value;
}
function matches(url: string, references: Set<string>) {
  const actual = silhouette(url);
  return [...references].some((reference) => {
    const expected = silhouette(reference);
    if (actual.width !== expected.width || actual.height !== expected.height)
      return false;
    const limit = Math.ceil(actual.mask.length / 3000);
    let changed = 0;
    for (let i = 0; i < actual.mask.length; i++) {
      if (actual.mask[i] === expected.mask[i]) continue;
      if (++changed > limit) return false;
      const x = i % actual.width,
        y = Math.floor(i / actual.width);
      let expectedEdge = false,
        actualEdge = false;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= actual.width || ny >= actual.height)
            continue;
          const neighbor = ny * actual.width + nx;
          expectedEdge ||= expected.mask[neighbor] === actual.mask[i];
          actualEdge ||= actual.mask[neighbor] === expected.mask[i];
        }
      if (!expectedEdge || !actualEdge) return false;
    }
    return true;
  });
}

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
// One application runs three walk/resize and click cases plus six pose/drag/return
// cases (52s locally). The 120s aggregate budget covers CI setup; each behavior
// retains its own short response deadline below.
test(
  "three sizes preserve left-facing interaction and autonomous movement across resizing",
  { timeout: 120000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mosey-size-autonomy-"));
    let app: ElectronApplication | undefined;
    let stopForge: (() => Promise<void>) | undefined;
    const evidence: unknown[] = [];
    const references = new Map<
      number,
      { right: Set<string>; left: Set<string> }
    >();
    try {
      if (!packaged) stopForge = await startForge();
      else
        execFileSync("/usr/bin/ditto", [
          path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
          path.join(root, "Mosey.app"),
        ]);
      const args = [
        `--user-data-dir=${root}/profile`,
        `--force-device-scale-factor=${process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"}`,
      ];
      app = await electron.launch(
        packaged
          ? {
              executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
              args,
            }
          : { args: [".", ...args] },
      );
      const pet = await app.firstWindow();
      await pet.waitForLoadState("load");
      const displaySession = await pet.context().newCDPSession(pet);
      const baseRatio = Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1");
      const changedRatio = baseRatio === 2 ? 1 : 2;
      const desktop = () =>
        app!.evaluate(({ BrowserWindow, screen }) => ({
          bounds: BrowserWindow.getAllWindows()[0]!.getBounds(),
          area: screen.getPrimaryDisplay().workArea,
          at: performance.now(),
        }));
      const menu = (label: string) =>
        app!.evaluate(({ Menu }, label) => {
          const item = Menu.getApplicationMenu()
            ?.items.find((item) => item.label === "Mosey")
            ?.submenu?.items.find((item) => item.label === label);
          if (!item) throw new Error(`Missing menu ${label}`);
          item.click();
        }, label);
      const choose = (label: string) =>
        app!.evaluate(({ Menu }, label) => {
          const item = Menu.getApplicationMenu()
            ?.items.find((item) => item.label === "Mosey")
            ?.submenu?.items.find((item) => item.label === "Size")
            ?.submenu?.items.find((item) => item.label === label);
          if (!item) throw new Error(`Missing size ${label}`);
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
      const footprint = () =>
        pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          const data = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let bottom = -1;
          for (let y = 0; y < canvas.height; y++)
            for (let x = 0; x < canvas.width; x++)
              if (data[(y * canvas.width + x) * 4 + 3] > 127) bottom = y;
          return {
            width: canvas.getBoundingClientRect().width,
            bottom: Math.round((bottom + 1) / devicePixelRatio),
          };
        });
      const raster = () =>
        pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          const data = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let opaque = 0;
          for (let i = 3; i < data.length; i += 4) if (data[i] > 127) opaque++;
          const rect = canvas.getBoundingClientRect();
          return {
            ratio: devicePixelRatio,
            width: canvas.width,
            height: canvas.height,
            cssWidth: rect.width,
            cssHeight: rect.height,
            opaque,
          };
        });
      const grounded = async () => {
        const { bounds, area } = await desktop();
        expect(bounds.y + bounds.height).toBe(area.y + area.height);
      };
      // Calibrate only visible pixels before the first seeded activity; all three
      // initial idle silhouettes face right. Their mirrors are external references.
      for (const [label, side] of [
        ["Small", 180],
        ["Medium", 240],
        ["Large", 300],
      ] as const) {
        await choose(label);
        await expect.poll(footprint).toEqual({ width: side, bottom: side });
        const right = new Set<string>(),
          left = new Set<string>();
        const until = Date.now() + 2150;
        while (Date.now() < until) {
          right.add(await pixels());
          left.add(
            await pet.evaluate(() => {
              const source = document.querySelector("canvas")!;
              const mirror = document.createElement("canvas");
              mirror.width = source.width;
              mirror.height = source.height;
              const context = mirror.getContext("2d")!;
              context.translate(source.width, 0);
              context.scale(-1, 1);
              context.drawImage(source, 0, 0);
              context.getImageData(0, 0, mirror.width, mirror.height);
              return mirror.toDataURL();
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
        for (const frame of right)
          expect(
            matches(frame, left),
            `opposite-facing negative control at ${side}`,
          ).toBe(false);
        references.set(side, { right, left });
      }
      await app.evaluate(() => {
        const control = { restMs: 60000 };
        Reflect.set(globalThis, "sizeAutonomyClock", control);
        const timeout = globalThis.setTimeout;
        globalThis.setTimeout = ((
          callback: (...args: unknown[]) => void,
          delay?: number,
          ...args: unknown[]
        ) =>
          timeout(
            callback,
            delay && delay >= 10000 ? control.restMs : delay,
            ...args,
          )) as typeof setTimeout;
      });
      const restClock = (ms: number) =>
        app!.evaluate((_electron, ms) => {
          Reflect.get(globalThis, "sizeAutonomyClock").restMs = ms;
        }, ms);
      const activity = async (random: number) => {
        await app!.evaluate((_electron, random) => {
          Math.random = () => random;
        }, random);
        await restClock(600);
        await menu("Hide Mosey");
        await menu("Show Mosey");
      };
      const visiblePoint = () =>
        pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          const data = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          const margin = Math.ceil(8 * devicePixelRatio);
          let best = Infinity,
            point: { x: number; y: number } | undefined;
          for (let y = margin; y < canvas.height - margin; y += 2)
            for (let x = margin; x < canvas.width - margin; x += 2) {
              let interior = true;
              for (const dy of [-margin, 0, margin])
                for (const dx of [-margin, 0, margin])
                  if (data[((y + dy) * canvas.width + x + dx) * 4 + 3] < 250)
                    interior = false;
              const distance =
                (x - canvas.width * 0.5) ** 2 + (y - canvas.height * 0.65) ** 2;
              if (interior && distance < best) {
                best = distance;
                point = {
                  x: (x + 0.5) / devicePixelRatio,
                  y: (y + 0.5) / devicePixelRatio,
                };
              }
            }
          if (!point) throw new Error("No robust visible body interior");
          return point;
        });
      for (const [startLabel, endLabel, side] of [
        ["Small", "Large", 300],
        ["Large", "Medium", 240],
        ["Medium", "Small", 180],
      ] as const) {
        await choose(startLabel);
        await activity(0.1);
        const origin = await desktop();
        await expect
          .poll(async () => (await desktop()).bounds.x, {
            timeout: 3000,
            interval: 20,
          })
          .toBeLessThan(origin.bounds.x - 15);
        await restClock(60000);
        const resize = await app.evaluate(
          ({ Menu, BrowserWindow, screen }, label) => {
            const pet = BrowserWindow.getAllWindows()[0]!;
            const before = pet.getBounds(),
              area = screen.getPrimaryDisplay().workArea;
            Menu.getApplicationMenu()!
              .items.find((item) => item.label === "Mosey")!
              .submenu!.items.find((item) => item.label === "Size")!
              .submenu!.items.find((item) => item.label === label)!
              .click();
            return {
              before,
              after: pet.getBounds(),
              area,
              at: performance.now(),
            };
          },
          endLabel,
        );
        expect(resize.after.x + resize.after.width / 2).toBe(
          resize.before.x + resize.before.width / 2,
        );
        expect(resize.after.y + resize.after.height).toBe(
          resize.before.y + resize.before.height,
        );
        expect(resize.after.width).toBe(side);
        await expect.poll(footprint).toEqual({ width: side, bottom: side });
        await new Promise((resolve) => setTimeout(resolve, 60));
        const next = await desktop();
        const previousCenter = resize.after.x + side / 2,
          nextCenter = next.bounds.x + side / 2;
        expect(nextCenter).toBeLessThan(previousCenter);
        // Allow real sampling latency and generous ordinary movement, but catch
        // a 30–60 DIP old-corner jump immediately after the resize.
        expect(previousCenter - nextCenter).toBeLessThan(
          10 + (next.at - resize.at) * 0.12,
        );
        await grounded();
        await pet.screenshot({
          path: `test-results/${packaged ? "packaged" : "development"}-size-autonomy-${side}-walking.png`,
          omitBackground: true,
        });
        const idle = references.get(side)!;
        await expect
          .poll(async () => matches(await pixels(), idle.left), {
            timeout: 4000,
            interval: 30,
          })
          .toBe(true);
        const finished = await desktop();
        const distance =
          origin.bounds.x +
          origin.bounds.width / 2 -
          finished.bounds.x -
          side / 2;
        expect(distance).toBeGreaterThan(140);
        expect(distance).toBeLessThanOrEqual(151);
        await grounded();
        // A primary-display DPR change can occur while hidden. The first visible
        // draw must rebuild the backing store without changing CSS/desktop size.
        await menu("Hide Mosey");
        await displaySession.send("Emulation.setDeviceMetricsOverride", {
          width: side,
          height: side,
          deviceScaleFactor: changedRatio,
          mobile: false,
        });
        await menu("Show Mosey");
        await expect.poll(raster, { timeout: 2500 }).toMatchObject({
          ratio: changedRatio,
          width: side * changedRatio,
          height: side * changedRatio,
          cssWidth: side,
          cssHeight: side,
        });
        const changedRaster = await raster();
        expect(changedRaster.opaque).toBeGreaterThan(
          2000 * changedRatio * changedRatio,
        );
        await expect.poll(footprint).toEqual({ width: side, bottom: side });
        await grounded();
        // The left-facing body/transparent input below runs at the changed DPR.
        // A second left-facing walk distinguishes a mirrored visible-body target
        // from its transparent reflected location, rather than using a symmetric torso.
        await activity(0.1);
        const clickOrigin = await desktop();
        await expect
          .poll(async () => (await desktop()).bounds.x, {
            timeout: 3000,
            interval: 20,
          })
          .toBeLessThan(clickOrigin.bounds.x - 15);
        await restClock(60000);
        const points = await pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!,
            ratio = devicePixelRatio;
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          const margin = Math.ceil(3 * ratio);
          for (let y = margin; y < canvas.height - margin; y += 2)
            for (let x = margin; x < canvas.width / 2; x += 2) {
              let valid = true;
              for (const dy of [-margin, 0, margin])
                for (const dx of [-margin, 0, margin]) {
                  if (
                    pixels[((y + dy) * canvas.width + x + dx) * 4 + 3] < 250 ||
                    pixels[
                      ((y + dy) * canvas.width + canvas.width - 1 - x - dx) *
                        4 +
                        3
                    ] !== 0
                  )
                    valid = false;
                }
              if (valid)
                return {
                  body: { x: (x + 0.5) / ratio, y: (y + 0.5) / ratio },
                  transparent: {
                    x: (canvas.width - x - 0.5) / ratio,
                    y: (y + 0.5) / ratio,
                  },
                };
            }
          throw new Error("No asymmetric left-body and transparent pair");
        });
        const beforeTransparent = await desktop();
        await pet.mouse.click(points.transparent.x, points.transparent.y);
        await new Promise((resolve) => setTimeout(resolve, 180));
        expect((await desktop()).bounds.x).toBeLessThan(
          beforeTransparent.bounds.x - 3,
        );
        await pet.mouse.click(points.body.x, points.body.y);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const clicked = await desktop();
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect((await desktop()).bounds).toEqual(clicked.bounds);
        await displaySession.send("Emulation.clearDeviceMetricsOverride");
        await expect.poll(raster, { timeout: 2500 }).toMatchObject({
          ratio: baseRatio,
          width: side * baseRatio,
          height: side * baseRatio,
          cssWidth: side,
          cssHeight: side,
        });
        const restoredRaster = await raster();
        expect(restoredRaster.opaque).toBeGreaterThan(
          2000 * baseRatio * baseRatio,
        );
        await expect
          .poll(async () => matches(await pixels(), idle.left), {
            timeout: 3000,
          })
          .toBe(true);
        for (const [choice, action] of [
          [0.6, "stretching"],
          [0.9, "playing"],
        ] as const) {
          await activity(choice);
          await expect
            .poll(
              async () =>
                matches(await pixels(), idle.left) ||
                matches(await pixels(), idle.right),
              { timeout: 2500, interval: 20 },
            )
            .toBe(false);
          await restClock(60000);
          await new Promise((resolve) => setTimeout(resolve, 350));
          await expect.poll(footprint).toEqual({ width: side, bottom: side });
          await grounded();
          await pet.screenshot({
            path: `test-results/${packaged ? "packaged" : "development"}-size-autonomy-${side}-${action}.png`,
            omitBackground: true,
          });
          // Keep synthetic capture away from the real OS cursor, as #4 does.
          await app.evaluate(({ BrowserWindow, screen }) => {
            const pet = BrowserWindow.getAllWindows()[0]!,
              area = screen.getPrimaryDisplay().workArea,
              b = pet.getBounds(),
              pointer = screen.getCursorScreenPoint();
            pet.setPosition(
              pointer.x > area.x + area.width / 2
                ? area.x
                : area.x + area.width - b.width,
              b.y,
              false,
            );
          });
          const point = await visiblePoint();
          const ground = await desktop();
          await pet.mouse.move(point.x, point.y);
          await pet.mouse.down();
          await pet.mouse.move(point.x, point.y - 120);
          await expect
            .poll(async () => (await desktop()).bounds.y)
            .toBeLessThan(ground.bounds.y - 100);
          const held = await desktop();
          await new Promise((resolve) => setTimeout(resolve, 1600));
          expect((await desktop()).bounds).toEqual(held.bounds);
          await pet.mouse.up();
          await expect
            .poll(
              async () => {
                const { bounds, area } = await desktop();
                return bounds.y + bounds.height - area.y - area.height;
              },
              { timeout: 4000 },
            )
            .toBe(0);
          await expect
            .poll(
              async () =>
                matches(await pixels(), idle.left) ||
                matches(await pixels(), idle.right),
              { timeout: 3000 },
            )
            .toBe(true);
        }
        evidence.push({
          side,
          resize,
          next,
          finished,
          points,
          clicked,
          changedRaster,
          restoredRaster,
          actions: ["walking", "stretching", "playing"],
        });
      }
      await writeFile(
        `test-results/${packaged ? "packaged" : "development"}-size-autonomy.json`,
        JSON.stringify(
          {
            evidence,
            boundary:
              "real Electron rendered pixels/window bounds/menu; directed input; random/long-rest time controlled externally",
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await mkdir("test-results", { recursive: true });
      await app
        ?.windows()[0]
        ?.screenshot({
          path: `test-results/failure-${packaged ? "packaged" : "development"}-size-autonomy.png`,
          timeout: 3000,
        })
        .catch(() => {});
      throw error;
    } finally {
      await app?.close().catch(() => {});
      await stopForge?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);
