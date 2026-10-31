import { expect } from "vitest";
import type { SessionOperation } from "./pet-session";
import type { ElectronApplication, Page } from "playwright";
import type { Presentation } from "../../src/shared/contract";

export async function waitForPetVisibility(
  app: ElectronApplication,
  pet: Page,
  visibility: Presentation["visibility"],
  { run = (_label, action) => action() }: { run?: SessionOperation } = {},
) {
  // macOS emits show/hide from occlusion changes, which need not occur when
  // a window starts on a sleeping display. Observe the actual outcome instead.
  await expect
    .poll(
      async () => {
        const native = await run("visibility-native", () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((window) => window.getTitle() === "Mosey")!
              .isVisible(),
          ),
        );
        const renderer = await run("visibility-presentation-and-paint", () =>
          pet.evaluate(async (expected) => {
            const presentation = (await window.mosey.getPresentation())
              .visibility;
            // A hidden pet need not paint. Visible interaction requires a live
            // document and painted content, in addition to the main-process state.
            let ready = expected === "hidden";
            if (!ready && !document.hidden) {
              const canvas = document.querySelector("canvas");
              if (canvas) {
                const pixels = canvas
                  .getContext("2d")!
                  .getImageData(0, 0, canvas.width, canvas.height).data;
                for (let i = 3; i < pixels.length; i += 4)
                  if (pixels[i]! >= 128) {
                    ready = true;
                    break;
                  }
              }
            }
            return { presentation, ready };
          }, visibility),
        );
        return { native, ...renderer };
      },
      { timeout: 5000 },
    )
    .toEqual({
      native: visibility === "visible",
      presentation: visibility,
      ready: true,
    });
}
