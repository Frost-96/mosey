import { expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Menu } from "electron";
import type { ElectronApplication, Page } from "playwright";
import type { Presentation } from "../src/shared/contract";
import { createPetTestSession } from "./support/pet-session";
import { evidencePath } from "./support/evidence";
import { matchPaintedFrames } from "./support/pixels";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const state = (pet: Page) => pet.evaluate(() => window.mosey.getPresentation());
const waitFor = (
  pet: Page,
  posture: Presentation["posture"],
  timeout = 12000,
) =>
  expect
    .poll(async () => (await state(pet)).posture, { timeout, interval: 20 })
    .toBe(posture);

async function bodyPoint(pet: Page) {
  return pet.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const { data, width, height } = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height);
    for (let y = Math.floor(height * 0.55); y < height * 0.8; y += 2)
      for (let x = Math.floor(width * 0.4); x < width * 0.6; x += 2)
        if (
          [-3, 0, 3].every((dx) =>
            [-3, 0, 3].every(
              (dy) => data[((y + dy) * width + x + dx) * 4 + 3]! > 220,
            ),
          )
        )
          return { x: x / devicePixelRatio, y: y / devicePixelRatio };
    throw new Error("No solid body point");
  });
}
async function choose(app: ElectronApplication, pet: Page, action: string) {
  const point = await bodyPoint(pet);
  await app.evaluate(() =>
    Reflect.set(globalThis, "continuityMenu", undefined),
  );
  await pet.mouse.click(point.x, point.y, { button: "right" });
  await expect
    .poll(() => app.evaluate(() => !!Reflect.get(globalThis, "continuityMenu")))
    .toBe(true);
  await app.evaluate((_electron, action) => {
    const menu = Reflect.get(globalThis, "continuityMenu") as Menu;
    const item = menu.getMenuItemById(`daily-action-${action}`);
    if (!item?.enabled) throw new Error(`Unavailable ${action}`);
    item.click();
    menu.closePopup();
  }, action);
}

type Painted = {
  action: string;
  frame: number;
  left: boolean;
  at: number;
  pixels: string;
};

test.each(["whale", "claude", "gemini", "gpt"])(
  "%s preserves facing and painted seated boundaries in the running pet",
  async (id) => {
    const session = await createPetTestSession({
      dock: "empty",
      preferences: {
        version: 3,
        character: id,
        size: 240,
        visibility: "visible",
      },
    });
    const directory = evidencePath(
      "motion-continuity",
      process.env.MOSEY_CONTINUITY_PHASE ?? "after",
      id,
    );
    await mkdir(directory, { recursive: true });
    try {
      const { app, pet } = await session.launch();
      await app.evaluate(({ Menu, BrowserWindow, screen }) => {
        Menu.prototype.popup = function (options) {
          Reflect.set(globalThis, "continuityMenu", this);
          Reflect.set(this, "continuityClose", options?.callback);
          this.emit("menu-will-show");
        };
        Menu.prototype.closePopup = function () {
          this.emit("menu-will-close");
          Reflect.get(this, "continuityClose")?.();
        };
        const pet = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "Mosey",
        )!;
        const area = screen.getPrimaryDisplay().workArea;
        const x = area.x + area.width - pet.getBounds().width - 10;
        pet.setPosition(x, pet.getBounds().y, false);
      });
      await pet.evaluate(async () => {
        const assets = await window.mosey.getCharacter();
        const canvas = document.querySelector("canvas")!;
        const records: Painted[] = [];
        Reflect.set(window, "continuityFrames", records);
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        Reflect.set(
          CanvasRenderingContext2D.prototype,
          "drawImage",
          function (this: CanvasRenderingContext2D, ...args: unknown[]) {
            const result = Reflect.apply(draw, this, args);
            if (
              this.canvas !== canvas ||
              !(args[0] instanceof HTMLImageElement)
            )
              return result;
            const image = args[0];
            const atlas = assets.atlases.find(
              (a) =>
                assets.images[a.image] === image.src ||
                (a.leftImage && assets.images[a.leftImage] === image.src),
            );
            if (!atlas) return result;
            records.push({
              action: atlas.action,
              frame: atlas.frames.findIndex(
                (f) => f.region.x === args[1] && f.region.y === args[2],
              ),
              left: this.getTransform().a < 0,
              at: Date.now(),
              pixels: canvas.toDataURL(),
            });
            return result;
          },
        );
      });
      await pause(600);
      await choose(app, pet, "looking");
      await waitFor(pet, "looking");
      await waitFor(pet, "resting");
      // Point at an idle expression rather than its initial neutral hold.
      await pause(1700);
      await choose(app, pet, "looking");
      await waitFor(pet, "looking");
      await waitFor(pet, "resting");
      if (id === "gpt") {
        await pause(1700);
        const point = await bodyPoint(pet);
        await pet.mouse.move(point.x, point.y);
        await pet.mouse.down();
        await expect
          .poll(async () => (await state(pet)).frozenAt)
          .not.toBeUndefined();
        const held = await pet.evaluate(() =>
          document.querySelector("canvas")!.toDataURL(),
        );
        await pause(200);
        expect(
          await pet.evaluate(() =>
            document.querySelector("canvas")!.toDataURL(),
          ),
        ).toBe(held);
        await pet.mouse.up();
        await expect
          .poll(async () => (await state(pet)).posture, { timeout: 5000 })
          .not.toBe("resting");
        await waitFor(pet, "resting");
        expect((await state(pet)).frozenAt).toBeUndefined();
      }
      await choose(app, pet, "sitting");
      await waitFor(pet, "sitting");
      await waitFor(pet, "standingup");
      await waitFor(pet, "resting");
      await choose(app, pet, "sitting");
      await waitFor(pet, "sitting");
      await pause(1000);
      await choose(app, pet, "standingup");
      await waitFor(pet, "standingup");
      await waitFor(pet, "resting");

      // Only rest waits are shortened. The actual main-process chooser and
      // authored walk/frame durations still run, including the facing change.
      await app.evaluate(() => {
        const timeout = globalThis.setTimeout;
        globalThis.setTimeout = ((
          callback: (...args: unknown[]) => void,
          delay?: number,
          ...args: unknown[]
        ) =>
          timeout(
            callback,
            delay !== undefined && delay >= 18000 && delay <= 32000
              ? 500
              : delay,
            ...args,
          )) as typeof setTimeout;
        Math.random = () => 0.1;
      });
      for (const label of ["Hide Mosey", "Show Mosey"])
        await app.evaluate(({ Menu }, label) => {
          Menu.getApplicationMenu()!
            .items.find((i) => i.label === "Mosey")!
            .submenu!.items.find((i) => i.label === label)!
            .click();
        }, label);
      await waitFor(pet, "walking");
      await waitFor(pet, "resting");
      const beforeQuiet = await state(pet);
      await app.evaluate(() => {
        Math.random = () => 0.58;
      });
      await waitFor(pet, "looking");
      const quiet = await state(pet);
      await waitFor(pet, "resting");
      const frames = await pet.evaluate(
        () => Reflect.get(window, "continuityFrames") as Painted[],
      );
      const images = new Map<string, string>();
      const samples = [];
      for (const frame of frames) {
        let file = images.get(frame.pixels);
        if (!file) {
          file = `${String(images.size).padStart(3, "0")}-${frame.action}-${frame.frame}.png`;
          images.set(frame.pixels, file);
          await writeFile(
            path.join(directory, file),
            Buffer.from(frame.pixels.split(",")[1]!, "base64"),
          );
        }
        const { action, frame: index, left, at } = frame;
        samples.push({ action, frame: index, left, at, file });
      }
      await writeFile(
        path.join(directory, "capture.json"),
        JSON.stringify({ beforeQuiet, quiet, samples }, null, 2),
      );
      const joins = frames.flatMap((frame, index) => {
        const previous = frames[index - 1];
        if (!previous) return [];
        return (previous.action === "sitting" &&
          frame.action === "standingup") ||
          (previous.action === "resting" &&
            ["looking", "sittingdown"].includes(frame.action))
          ? [{ previous, frame }]
          : [];
      });
      expect(
        joins.filter(({ frame }) => frame.action === "standingup"),
      ).toHaveLength(2);
      for (const { previous, frame } of joins)
        expect(
          matchPaintedFrames([previous.pixels])(frame.pixels),
          `${id}: ${previous.action}[${previous.frame}] → ${frame.action}[${frame.frame}]`,
        ).toBe(true);
      expect(beforeQuiet.direction).toBe("left");
      expect(quiet.direction).toBe(beforeQuiet.direction);
    } finally {
      await session.close();
    }
  },
);
