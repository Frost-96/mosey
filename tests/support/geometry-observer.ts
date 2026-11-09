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
  { detailed = false }: { detailed?: boolean } = {},
) {
  const input = await app.evaluateHandle(
    ({ ipcMain, BrowserWindow, screen }, detailed) => {
      let frame: Extract<PetInput, { type: "frame" }> | undefined;
      const records: unknown[] = [];
      const record = (detail: object) => {
        const window = BrowserWindow.getAllWindows().find(
          (entry) => entry.getTitle() === "Mosey",
        );
        records.push({
          time: Date.now(),
          ...detail,
          bounds: window?.getBounds(),
          ...(detailed
            ? {
                visible: window?.isVisible(),
                cursor: screen.getCursorScreenPoint(),
              }
            : {}),
        });
        if (records.length > 400) records.shift();
      };
      const receive = (_event: unknown, value: PetInput) => {
        if (value.type === "frame") frame = value;
        record({ input: value });
      };
      ipcMain.on("pet:input", receive);
      const window = BrowserWindow.getAllWindows().find(
        (entry) => entry.getTitle() === "Mosey",
      )!;
      const nativeEvents: NodeJS.EventEmitter = window;
      const lifecycle = [
        "blur",
        "focus",
        "show",
        "hide",
        "unresponsive",
      ] as const;
      const listeners = (detailed ? lifecycle : []).map((event) => {
        const listener = () => record({ event });
        nativeEvents.on(event, listener);
        return () => nativeEvents.off(event, listener);
      });
      const metrics = (
        _event: unknown,
        display: Electron.Display,
        changed: string[],
      ) => record({ event: "display-metrics-changed", display, changed });
      const added = (_event: unknown, display: Electron.Display) =>
        record({ event: "display-added", display });
      const removed = (_event: unknown, display: Electron.Display) =>
        record({ event: "display-removed", display });
      if (detailed) {
        screen.on("display-metrics-changed", metrics);
        screen.on("display-added", added);
        screen.on("display-removed", removed);
      }
      return {
        records,
        frame: () => frame,
        stop() {
          ipcMain.off("pet:input", receive);
          for (const remove of listeners) remove();
          screen.off("display-metrics-changed", metrics);
          screen.off("display-added", added);
          screen.off("display-removed", removed);
        },
      };
    },
    detailed,
  );
  const renderer = await pet.evaluateHandle((detailed) => {
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
      ...(detailed ? ["pointermove", "gotpointercapture"] : []),
    ];
    const pointer = (event: Event) => {
      const value = event as PointerEvent;
      const canvas = document.querySelector("canvas")!;
      const bounds = canvas.getBoundingClientRect();
      const x = value.clientX - bounds.left;
      const y = value.clientY - bounds.top;
      const alpha =
        !detailed || value.type === "pointerdown"
          ? canvas
              .getContext("2d")!
              .getImageData(
                Math.floor(x * devicePixelRatio),
                Math.floor(y * devicePixelRatio),
                1,
                1,
              ).data[3]
          : undefined;
      record({
        type: value.type,
        x,
        y,
        alpha,
        buttons: value.buttons,
        ...(detailed
          ? {
              button: value.button,
              pointerId: value.pointerId,
              capture: canvas.hasPointerCapture(value.pointerId),
              screenX: value.screenX,
              screenY: value.screenY,
              windowX: window.screenX,
              windowY: window.screenY,
            }
          : {}),
      });
    };
    const blur = () => record({ type: "blur" });
    if (detailed) {
      window.addEventListener("blur", blur);
      const canvas = document.querySelector("canvas")!;
      record({
        type: "observer-start",
        label: canvas.getAttribute("aria-label"),
        scaleFactor: devicePixelRatio,
        width: canvas.width,
        height: canvas.height,
      });
    }
    for (const type of types) document.addEventListener(type, pointer, true);
    return {
      records,
      stop() {
        unsubscribe();
        window.removeEventListener("blur", blur);
        for (const type of types)
          document.removeEventListener(type, pointer, true);
      },
    };
  }, detailed);
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
