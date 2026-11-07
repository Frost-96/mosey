import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import { createPetTestSession } from "./support/pet-session";
import { openSettings, closeSettings } from "./support/settings";
import { distanceFromGround } from "./support/ground";
import { evidencePath } from "./support/evidence";

async function observe(pet: Page) {
  return pet.evaluate(async () => {
    const presentation = await window.mosey.getPresentation();
    const canvas = document.querySelector("canvas")!;
    const pixels = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let top = canvas.height,
      bottom = -1,
      opaque = 0;
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++)
        if (pixels[(y * canvas.width + x) * 4 + 3]! >= 128) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
          opaque++;
        }
    return {
      posture: presentation.posture,
      elapsed: Date.now() - presentation.startedAt,
      height: (bottom - top + 1) / devicePixelRatio,
      opaque,
    };
  });
}

test.each([
  ["whale", "DeepSeek"],
  ["claude", "Claude"],
  ["gemini", "Gemini"],
  ["gpt", "GPT"],
] as const)(
  "%s is selectable and durable, flails, flops, and stands back up",
  async (id, name) => {
    const f = await createPetTestSession({
      dock: "empty",
      scaleFactor: process.env.MOSEY_TEST_SCALE_FACTOR ?? "1",
      preferences: {
        version: 3,
        character: "corgi",
        size: 160,
        visibility: "visible",
      },
    });
    try {
      let { app, pet } = await f.launch();
      let settings = await openSettings(app);
      expect(
        await settings.locator("#character option").allTextContents(),
      ).toEqual(["DeepSeek", "Claude", "Gemini", "GPT", "柯基"]);
      await expect
        .poll(() => pet.locator("canvas").getAttribute("aria-label"))
        .toBe("柯基 · 待机");
      const before = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Mosey")!
          .getBounds(),
      );
      await settings.getByRole("combobox", { name: "角色" }).selectOption(id);
      await expect
        .poll(() => pet.locator("canvas").getAttribute("aria-label"), {
          timeout: 10000,
        })
        .toBe(`${name} · 待机`);
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.getTitle() === "Mosey")!
            .getBounds(),
        ),
      ).toEqual(before);
      ({ app, pet } = await f.restart());
      settings = await openSettings(app);
      expect(
        await settings.getByRole("combobox", { name: "角色" }).inputValue(),
      ).toBe(id);
      await expect
        .poll(() => pet.locator("canvas").getAttribute("aria-label"))
        .toBe(`${name} · 待机`);
      await settings.screenshot({
        path: evidencePath(`characters-${id}-settings.png`),
      });
      await closeSettings(app);
      const errors: string[] = [];
      pet.on("pageerror", (error) => errors.push(error.message));
      await pet.evaluate(() => {
        const events: { posture: string; at: number }[] = [];
        Reflect.set(window, "observedCharacterMotion", events);
        window.mosey.onPresentation((p) => {
          if (events.at(-1)?.posture !== p.posture)
            events.push({ posture: p.posture, at: Date.now() });
        });
      });
      // Place the fixture away from the physical pointer before directed input.
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
      const idle = await observe(pet);
      expect(idle.opaque).toBeGreaterThan(500);
      await pet.screenshot({
        path: evidencePath(`characters-${id}-idle.png`),
        omitBackground: true,
      });
      const body = await pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        const y = Math.floor(canvas.height * 0.65);
        for (
          let x = Math.floor(canvas.width * 0.4);
          x < canvas.width * 0.6;
          x++
        )
          if (pixels[(y * canvas.width + x) * 4 + 3]! >= 200)
            return { x: x / devicePixelRatio, y: y / devicePixelRatio };
        throw new Error("No opaque body to pick up");
      });
      await pet.mouse.move(body.x, body.y);
      await pet.mouse.down();
      await pet.mouse.move(body.x, body.y - 120, { steps: 4 });
      await expect.poll(() => distanceFromGround(app)).toBeLessThan(-60);
      await expect
        .poll(async () => (await observe(pet)).posture)
        .toBe("dragging");
      await pet.screenshot({
        path: evidencePath(`characters-${id}-dragging.png`),
        omitBackground: true,
      });
      await pet.mouse.up();
      await expect
        .poll(async () => (await observe(pet)).posture, {
          timeout: 3000,
          interval: 30,
        })
        .toBe("landing");
      const samples = [];
      let flopCaptured = false,
        riseCaptured = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const sample = await observe(pet);
        samples.push(sample);
        if (sample.posture === "resting") break;
        if (
          sample.posture === "landing" &&
          sample.elapsed >= 300 &&
          sample.elapsed < 700 &&
          !flopCaptured
        ) {
          await pet.screenshot({
            path: evidencePath(`characters-${id}-flop.png`),
            omitBackground: true,
          });
          flopCaptured = true;
        }
        if (
          sample.posture === "landing" &&
          sample.elapsed >= 1200 &&
          sample.elapsed < 1500 &&
          !riseCaptured
        ) {
          await pet.screenshot({
            path: evidencePath(`characters-${id}-rising.png`),
            omitBackground: true,
          });
          riseCaptured = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      expect(samples.at(-1)?.posture).toBe("resting");
      const landing = samples.filter((s) => s.posture === "landing");
      expect(Math.min(...landing.map((s) => s.height))).toBeLessThan(
        idle.height * 0.72,
      );
      expect(
        Math.max(
          ...landing.filter((s) => s.elapsed > 2300).map((s) => s.height),
        ),
      ).toBeGreaterThan(idle.height * 0.9);
      expect(flopCaptured && riseCaptured).toBe(true);
      expect(await distanceFromGround(app)).toBe(0);
      const events = await pet.evaluate(
        () =>
          Reflect.get(window, "observedCharacterMotion") as {
            posture: string;
            at: number;
          }[],
      );
      expect(events.map((e) => e.posture)).toEqual(
        expect.arrayContaining([
          "dragging",
          "flutter",
          "falling",
          "landing",
          "resting",
        ]),
      );
      const landed = events.find((e) => e.posture === "landing")!;
      const stood = events.find(
        (e) => e.posture === "resting" && e.at > landed.at,
      )!;
      expect(stood.at - landed.at).toBeGreaterThanOrEqual(2950);
      await pet.screenshot({
        path: evidencePath(`characters-${id}-standing.png`),
        omitBackground: true,
      });
      await writeFile(
        evidencePath(`characters-${id}-motion.json`),
        JSON.stringify({ events, samples }, null, 2),
      );
      expect(errors).toEqual([]);
    } finally {
      await f.close();
    }
  },
);
