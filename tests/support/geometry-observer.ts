import { expect, onTestFinished } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { writeFile } from "node:fs/promises";
import type { PetInput, Presentation } from "../../src/shared/contract";
import { evidencePath } from "./evidence";
import { finishGeometryObservation } from "./geometry-observer-cleanup";

// Observe the existing input boundary without replacing its listeners or
// changing the frame reports that drive the application's real hit regions.
export async function observeGeometry(
  app: ElectronApplication,
  pet: Page,
  label: string,
) {
  const input = await app.evaluateHandle(({ ipcMain, BrowserWindow }) => {
    let frame: Extract<PetInput, { type: "frame" }> | undefined;
    const records: unknown[] = [];
    const record = (_event: unknown, value: PetInput) => {
      if (value.type === "frame") frame = value;
      const window = BrowserWindow.getAllWindows().find(
        (entry) => entry.getTitle() === "Mosey",
      );
      records.push({
        time: Date.now(),
        input: value,
        bounds: window?.getBounds(),
      });
      if (records.length > 400) records.shift();
    };
    ipcMain.on("pet:input", record);
    return {
      records,
      frame: () => frame,
      stop: () => ipcMain.off("pet:input", record),
    };
  });
  const renderer = await pet.evaluateHandle(() => {
    const records: unknown[] = [];
    const record = (detail: unknown) => {
      records.push({ time: Date.now(), detail });
      if (records.length > 400) records.shift();
    };
    const unsubscribe = window.mosey.onPresentation((presentation) =>
      record({ presentation }),
    );
    const types = [
      "pointerdown",
      "pointerup",
      "pointercancel",
      "lostpointercapture",
    ];
    const pointer = (event: Event) => {
      const value = event as PointerEvent;
      const canvas = document.querySelector("canvas")!;
      const bounds = canvas.getBoundingClientRect();
      const x = value.clientX - bounds.left;
      const y = value.clientY - bounds.top;
      const alpha = canvas
        .getContext("2d")!
        .getImageData(
          Math.floor(x * devicePixelRatio),
          Math.floor(y * devicePixelRatio),
          1,
          1,
        ).data[3];
      record({ type: value.type, x, y, alpha, buttons: value.buttons });
    };
    for (const type of types) document.addEventListener(type, pointer, true);
    return {
      records,
      stop() {
        unsubscribe();
        for (const type of types)
          document.removeEventListener(type, pointer, true);
      },
    };
  });
  onTestFinished(async ({ task }) => {
    const failed = task.result?.state === "fail";
    const evidence = await finishGeometryObservation({
      records: failed
        ? () =>
            Promise.allSettled([
              input.evaluate((trace) => trace.records),
              renderer.evaluate((trace) => trace.records),
            ])
        : undefined,
      stop: () =>
        Promise.allSettled([
          input.evaluate((trace) => trace.stop()),
          renderer.evaluate((trace) => trace.stop()),
        ]),
      dispose: () => Promise.allSettled([input.dispose(), renderer.dispose()]),
    });
    if (failed || evidence.unavailable.length)
      await writeFile(
        evidencePath(`failure-geometry-${label}.json`),
        JSON.stringify(evidence, null, 2),
      ).catch(() => {}); // Diagnostics must not replace the original failure.
  });
  const readFrame = () => input.evaluate((trace) => trace.frame());
  return {
    readFrame,
    async waitForPaint(presentation: Presentation) {
      await expect.poll(readFrame, { timeout: 5000 }).toMatchObject({
        actionId: presentation.actionId,
        geometryRevision: presentation.geometryRevision,
      });
    },
  };
}
