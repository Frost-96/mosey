import type { ElectronApplication } from "playwright";

type Electron = typeof import("electron");

// Inspector evaluation reaches the main thread as a V8 interrupt, which can
// land inside Node's dispatch of a timer: after listOnTimeout has checked the
// timer's callback and before it calls it. Hide Mosey clears the pet's pointer
// poll; run there, it clears that very timer, Node throws "timer._onTimeout is
// not a function", and the uncaught exception opens Electron's modal error
// dialog, after which the main thread answers nothing (#121). A real menu click
// is its own native event and never runs there. Input driven into the main
// process therefore runs after a turn of its event loop, outside any timer.
export function onMainLoop<R, Arg = undefined>(
  app: Pick<ElectronApplication, "evaluate">,
  input: (electron: Electron, arg: Arg) => R | Promise<R>,
  arg?: Arg,
): Promise<Awaited<R>> {
  return app.evaluate(
    async (electron, { source, arg }) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      // Playwright sends an evaluated function as its source; so does this.
      return (0, eval)(`(${source})`)(electron, arg);
    },
    { source: input.toString(), arg },
  );
}
