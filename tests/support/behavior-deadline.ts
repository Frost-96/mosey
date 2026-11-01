import type { Presentation } from "../../src/shared/contract";

type Interruption = "none" | "work-area" | "unmatched" | "second" | "hidden";

// Serialized directly by Playwright into the owned test application's main.
// Supply the original direct input or the walking-publication reentry input;
// neither the behavior actor nor an internal state snapshot is exposed.
export async function exerciseBehaviorDeadline(
  {
    BrowserWindow,
    screen,
    powerMonitor,
    ipcMain,
    app,
  }: typeof import("electron"),
  {
    journal,
    duringPublication,
    interruption = "none",
  }: {
    journal: string;
    duringPublication: boolean;
    interruption?: Interruption;
  },
) {
  // Synchronous bounded trace writes preserve failures but may affect timing.
  // Lines reflect observer execution order, not inferred OS arrival order.
  const { appendFileSync } = process.getBuiltinModule("node:fs");
  let events = 0;
  let bytes = 0;
  let exhausted = false;
  const record = (event: string, detail?: unknown) => {
    if (exhausted) return;
    const entry = {
      event,
      at: Date.now(),
      monotonic: performance.now(),
      detail,
    };
    const line = JSON.stringify(entry) + "\n";
    const length = Buffer.byteLength(line);
    // Keep the public trace on failure without unbounded per-frame output.
    // Reserve room for one explicit truncation marker below the 64 KiB cap.
    if (++events > 256 || bytes + length > 63 * 1024) {
      exhausted = true;
      appendFileSync(
        journal,
        JSON.stringify({ event: "trace-limit", at: Date.now() }) + "\n",
      );
      return;
    }
    appendFileSync(journal, line);
    bytes += length;
  };
  let nativeEpoch = 0;
  // Native lifecycle inputs can interrupt an activity after its input has
  // completed. Record their order alongside real presentation messages.
  screen.on("display-metrics-changed", (_event, display, metrics) =>
    record("display-metrics-changed", {
      metrics,
      workArea: display.workArea,
    }),
  );
  screen.on("display-added", (_event, display) => {
    nativeEpoch++;
    record("display-added", display.workArea);
  });
  screen.on("display-removed", (_event, display) => {
    nativeEpoch++;
    record("display-removed", display.workArea);
  });
  const nativeEvent = (event: string) => () => {
    nativeEpoch++;
    record(event);
  };
  powerMonitor.on("resume", nativeEvent("resume"));
  powerMonitor.on("suspend", nativeEvent("suspend"));
  powerMonitor.on("unlock-screen", nativeEvent("unlock-screen"));
  powerMonitor.on("lock-screen", nativeEvent("lock-screen"));
  ipcMain.on("pet:input", (_event, input) => {
    if (!duringPublication) record("input-handled", input);
    else if (input?.type !== "frame") record("pet-input", input);
  });
  const controller = Reflect.get(globalThis, Symbol.for("mosey.test.behavior"));
  if (!controller)
    throw new Error("Controlled behavior build was not installed");
  const contents = BrowserWindow.getAllWindows().find(
    (window) => window.getTitle() === "Mosey",
  )!.webContents;
  const pet = BrowserWindow.fromWebContents(contents)!;
  const originalSend = contents.send;
  let latestPresentation: Presentation | undefined;
  let displayBefore:
    | { presentation: Presentation; inputEpoch: number; nativeEpoch: number }
    | undefined;
  let completedAdvance = false;
  let originalSettling: Presentation | undefined;
  let displayCancellation:
    { before: Presentation; after: Presentation } | undefined;
  let newIdleInput: Promise<void> | undefined;
  let displayFailure: Error | undefined;
  let closing = false;
  let transactionOpen = true;

  let inputDeadline = -Infinity;
  let inputEpoch = 0;
  let firstSettling: Presentation | undefined;
  ipcMain.prependListener("pet:input", (_event, input) => {
    if (input?.type !== "frame") inputEpoch++;
    if (!duringPublication) record("input-arrived", input);
  });
  // Only a work-area event that synchronously cancels the completed input's
  // visible settling action permits one new idle-cycle input. A generic
  // resting result, polling failure or another native event grants no input.
  const beforeDisplayChange = (
    _event: Electron.Event,
    display: Electron.Display,
    metrics: string[],
  ) => {
    nativeEpoch++;
    displayBefore =
      completedAdvance &&
      display.id === screen.getPrimaryDisplay().id &&
      metrics.length === 1 &&
      metrics[0] === "workArea" &&
      latestPresentation
        ? { presentation: latestPresentation, inputEpoch, nativeEpoch }
        : undefined;
    record("work-area-boundary-before", displayBefore);
  };
  const afterDisplayChange = () => {
    const boundary = displayBefore;
    displayBefore = undefined;
    if (!boundary) return;
    const before = boundary.presentation;
    if (displayCancellation) {
      displayFailure = new Error(
        "A second work-area cancellation exceeded this input transaction",
      );
      record("new-idle-input-refused", displayFailure.message);
      return;
    }
    if (
      before.posture !== "settling" ||
      before.visibility !== "visible" ||
      before.actionId !== originalSettling?.actionId
    )
      return;
    if (
      boundary.inputEpoch !== inputEpoch ||
      boundary.nativeEpoch !== nativeEpoch
    ) {
      displayFailure = new Error(
        "Another input interrupted the work-area cancellation boundary",
      );
      record("new-idle-input-refused", displayFailure.message);
      return;
    }
    const after = latestPresentation;
    if (
      after?.posture !== "resting" ||
      after.visibility !== "visible" ||
      after.actionId <= before.actionId
    ) {
      displayFailure = new Error(
        "Work-area event did not publish a new visible rest after settling",
      );
      return;
    }
    displayCancellation = { before, after };
    record("work-area-cancelled-settling", displayCancellation);
    record("new-idle-input-requested", 180000);
    const epoch = inputEpoch;
    const native = nativeEpoch;
    newIdleInput = controller
      .update(
        { advanceBy: 180000 },
        () =>
          transactionOpen &&
          !closing &&
          !displayFailure &&
          performance.now() < inputDeadline &&
          !pet.isDestroyed() &&
          pet.isVisible() &&
          latestPresentation?.actionId === after.actionId &&
          latestPresentation?.posture === "resting" &&
          latestPresentation?.visibility === "visible" &&
          latestPresentation?.geometryRevision === after.geometryRevision &&
          inputEpoch === epoch &&
          nativeEpoch === native,
      )
      .then(
        () => record("new-idle-input-complete", 180000),
        (error: Error) => {
          displayFailure ??= error;
          record("new-idle-input-refused", error.message);
        },
      );
  };
  const stopDisplayRecovery = () => {
    transactionOpen = false;
    screen.off("display-metrics-changed", beforeDisplayChange);
    screen.off("display-metrics-changed", afterDisplayChange);
  };
  screen.prependListener("display-metrics-changed", beforeDisplayChange);
  screen.on("display-metrics-changed", afterDisplayChange);
  app.once("before-quit", () => {
    closing = true;
    record("before-quit");
    contents.send = originalSend;
    // All observers belong to this process; stop writing before its root
    // can be released by the session after the actual process exit.
    exhausted = true;
  });
  pet.once("closed", () => {
    closing = true;
  });
  pet.on("show", nativeEvent("show"));
  pet.on("hide", nativeEvent("hide"));
  pet.on("unresponsive", nativeEvent("unresponsive"));
  contents.on("did-start-loading", nativeEvent("did-start-loading"));
  contents.on("did-finish-load", nativeEvent("did-finish-load"));
  if (duringPublication)
    record("initial-display", screen.getPrimaryDisplay().workArea);
  else
    record("initial-window", {
      bounds: pet.getBounds(),
      visible: pet.isVisible(),
      workArea: screen.getPrimaryDisplay().workArea,
    });
  pet.on("move", () => record("move", pet.getBounds()));
  pet.on("resize", () => record("resize", pet.getBounds()));
  pet.on("focus", () => record("focus"));
  pet.on("blur", () => record("blur"));
  contents.on("render-process-gone", (_event, details) =>
    record("render-process-gone", details),
  );
  let injected = false;
  let displayReplayScheduled = false;
  const observations: {
    posture: string;
    actionId: number;
    wall: number;
  }[] = [];
  let nested:
    | Promise<{
        immediately: number;
        wall: number;
        monotonic: number;
        firstWakeup: { wall: number; monotonic: number } | undefined;
      }>
    | undefined;
  const advanceInput = async () => {
    const wall = Date.now();
    const monotonic = performance.now();
    inputDeadline = monotonic + 300;
    record("real-deadline-start", { wall, monotonic, duration: 300 });
    let firstWakeup: { wall: number; monotonic: number } | undefined;
    const timeout = new Promise<void>((resolve) => {
      // A timer callback can arrive before its nominal delay. Keep the
      // deadline at 300 real milliseconds; only rearm its remaining time.
      const check = () => {
        const elapsed = {
          wall: Date.now() - wall,
          monotonic: performance.now() - monotonic,
        };
        record("deadline-wakeup", elapsed);
        firstWakeup ??= elapsed;
        const remaining = 300 - Math.min(elapsed.wall, elapsed.monotonic);
        if (remaining > 0) setTimeout(check, remaining);
        else resolve();
      };
      setTimeout(check, 300);
    });
    record("advance-requested", 180000);
    await controller.update({ advanceBy: 180000 });
    record("advance-complete", 180000);
    completedAdvance = true;
    originalSettling =
      latestPresentation?.posture === "settling"
        ? latestPresentation
        : undefined;
    const immediately = Date.now() - wall;
    await timeout;
    return {
      immediately,
      firstWakeup,
      wall: Date.now() - wall,
      monotonic: performance.now() - monotonic,
    };
  };
  contents.send = function (channel, ...args) {
    originalSend.call(this, channel, ...args);
    if (channel !== "pet:presentation") {
      if (channel === "pet:gesture-cancellation") record(channel, args[0]);
      return;
    }
    const presentation = args[0];
    if (!presentation || typeof presentation.posture !== "string") return;
    record(
      duringPublication ? "presentation" : "pet:presentation",
      presentation,
    );
    latestPresentation = presentation;
    if (presentation.posture === "settling") firstSettling ??= presentation;
    if (
      interruption !== "none" &&
      presentation.posture === "settling" &&
      !displayReplayScheduled
    ) {
      displayReplayScheduled = true;
      setTimeout(() => {
        const display = screen.getPrimaryDisplay();
        const replay = {
          ...display,
          workArea: {
            ...display.workArea,
            height: display.workArea.height - 1,
          },
        };
        const metrics =
          interruption === "unmatched" ? ["bounds"] : ["workArea"];
        record("display-event-replay", {
          metrics,
          workArea: replay.workArea,
        });
        // Replay the public event; the actual OS work area is unchanged.
        screen.emit("display-metrics-changed", {}, replay, metrics);
        if (interruption === "hidden") pet.hide();
        if (interruption === "second")
          setTimeout(() => {
            record("second-display-event-replay", {
              metrics,
              workArea: replay.workArea,
            });
            screen.emit("display-metrics-changed", {}, replay, metrics);
          }, 20);
      }, 220);
    }
    if (!duringPublication || injected) return;
    observations.push({
      posture: presentation.posture,
      actionId: presentation.actionId,
      wall: Date.now(),
    });
    if (presentation.posture !== "walking") return;
    injected = true;
    nested = advanceInput();
  };
  try {
    if (duringPublication) {
      record("advance-requested", 30000);
      await controller.update({ advanceBy: 30000 });
      record("advance-complete", 30000);
      if (!nested)
        throw new Error("The initial activity did not publish walking");
    } else nested = advanceInput();
    const elapsed = await nested;
    // Recovery authority ends with the original real 300ms deadline. Do
    // not reset that deadline or extend the subsequent sleep poll budget.
    stopDisplayRecovery();
    await newIdleInput;
    return {
      ...elapsed,
      observations,
      firstSettling,
      displayCancellation,
      inputFailure: displayFailure?.message,
    };
  } finally {
    stopDisplayRecovery();
    record("input-evaluation-return");
  }
}
