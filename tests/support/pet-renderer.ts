import { expect } from "vitest";
import type { ElectronApplication } from "playwright";
import type { Presentation } from "../../src/shared/contract";

type PetObservation = {
  visible: boolean;
  documentHidden: boolean;
  presentation: Presentation;
  label: string | null;
  width: number;
  scaleFactor: number;
  opaquePixels: number;
  pixels: string;
  mirroredPixels: string;
};

// Driver calls do not necessarily settle when their renderer/main process is
// stalled. Bound the transport too, not only the polling assertions inside it.
async function within<T>(
  operation: Promise<T>,
  timeout: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A crashed Playwright Page stays crashed even when Electron reloads its
// WebContents. Resolve the live pet on each observation through Electron's
// public API; neither a cached Page nor a production test hook is needed.
export function observePetRenderer(app: ElectronApplication) {
  const child = app.process();
  const read = (): Promise<PetObservation | null> =>
    app.evaluate(async ({ BrowserWindow }) => {
      const pet = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Mosey",
      );
      if (!pet || pet.webContents.isCrashed() || pet.webContents.isLoading())
        return null;
      const visible = pet.isVisible();
      const rendered = await pet.webContents.executeJavaScript(`(async () => {
        const canvas = document.querySelector("canvas");
        if (!canvas || !window.mosey) return null;
        const presentation = await window.mosey.getPresentation();
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let opaquePixels = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] >= 128) opaquePixels++;
        const mirror = document.createElement("canvas");
        mirror.width = canvas.width;
        mirror.height = canvas.height;
        const context = mirror.getContext("2d");
        context.translate(canvas.width, 0);
        context.scale(-1, 1);
        context.drawImage(canvas, 0, 0);
        return {
          presentation, documentHidden: document.hidden,
          label: canvas.getAttribute("aria-label"),
          width: canvas.width / devicePixelRatio, scaleFactor: devicePixelRatio,
          opaquePixels, pixels: canvas.toDataURL(), mirroredPixels: mirror.toDataURL()
        };
      })()`);
      return rendered ? { visible, ...rendered } : null;
    });

  const waitFor = async (
    accept: (observation: PetObservation) => boolean,
    timeout: number,
  ) => {
    let observed: PetObservation | null = null;
    await within(
      expect
        .poll(
          async () => {
            observed = await read();
            return observed !== null && accept(observed);
          },
          { timeout },
        )
        .toBe(true),
      timeout,
      `Pet observation did not become ready within ${timeout}ms`,
    );
    // Return the exact observation that satisfied the condition, without a
    // second pixel read that could skip the first observed painted frame.
    return observed!;
  };

  return {
    read,
    // Some scenarios deliberately show a newly loaded document while its
    // images are still decoding. Document availability is not paint readiness.
    waitForDocument: () => waitFor(() => true, 1000),
    waitUntilReady({ timeout = 10000, paintedPixels = 0 } = {}) {
      return waitFor((observed) => {
        if (!/^(鲸鱼娘|柯基) · /.test(observed.label ?? "")) return false;
        if (observed.presentation.visibility === "hidden")
          return !observed.visible;
        return (
          observed.visible &&
          !observed.documentHidden &&
          observed.opaquePixels > paintedPixels
        );
      }, timeout);
    },
    async crash() {
      await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows().find(
          (window) => window.getTitle() === "Mosey",
        )!.webContents;
        // A crash request can return while the old renderer is still alive.
        // Wait for its actual exit before examining a replacement document.
        return new Promise<void>((resolve, reject) => {
          const exited = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            contents.off("render-process-gone", exited);
            reject(new Error("Renderer did not exit after crash request"));
          }, 5000);
          contents.once("render-process-gone", exited);
          try {
            contents.forcefullyCrashRenderer();
          } catch (error) {
            clearTimeout(timer);
            contents.off("render-process-gone", exited);
            reject(error);
          }
        });
      });
    },
    async withColdImages<T>(action: () => Promise<T>): Promise<T> {
      await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows().find(
          (window) => window.getTitle() === "Mosey",
        )!.webContents;
        Reflect.set(globalThis, "recoveryImageRequested", false);
        contents.session.webRequest.onBeforeRequest((details, callback) => {
          if (
            details.webContentsId === contents.id &&
            details.resourceType === "image"
          ) {
            Reflect.set(globalThis, "recoveryImageRequested", true);
            setTimeout(() => callback({ cancel: false }), 2000);
          } else callback({ cancel: false });
        });
      });
      let outcome: { value: T } | { error: unknown };
      try {
        const result = await action();
        // This checks that the network fault was exercised, not an internal
        // renderer field or a timer call count. Pixels remain the acceptance.
        expect(
          await app.evaluate(() =>
            Reflect.get(globalThis, "recoveryImageRequested"),
          ),
        ).toBe(true);
        outcome = { value: result };
      } catch (error) {
        outcome = { error };
      }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          await within(
            app.evaluate(({ BrowserWindow }) => {
              BrowserWindow.getAllWindows()
                .find((window) => window.getTitle() === "Mosey")
                ?.webContents.session.webRequest.onBeforeRequest(null);
            }),
            1000,
            "Cold image interception cleanup did not finish within 1000ms",
          );
        } catch (cleanup) {
          if ("error" in outcome)
            throw new AggregateError(
              [outcome.error, cleanup],
              "Cold image action and cleanup failed",
              { cause: cleanup },
            );
          throw cleanup;
        }
      }
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    },
  };
}
