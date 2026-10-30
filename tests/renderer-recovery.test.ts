import { controlBehavior, advanceRest } from "./support/controlled-behavior";
import { test, expect } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { distanceFromGround } from "./support/ground";
import { openSettings } from "./support/settings";
import { matchPaintedFrames } from "./support/pixels";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

test.each([
  "dragging",
  "falling",
  "hidden",
  "walking",
  "sleeping",
  "preview",
  "main",
])(
  "%s failure preserves the bounded recovery and process lifecycle",
  async (phase) => {
    const session = await createPetTestSession({
      dock: "empty",
      ...(["walking", "sleeping"].includes(phase)
        ? { behavior: { random: 0.1 } }
        : {}),
      isolateAppIdentity: phase === "main",
      preferences: {
        version: 3,
        character: "corgi",
        size: 240,
        visibility: "visible",
      },
    });
    const { app, pet: page, renderer } = await session.launch();
    const drawn = async () =>
      (await session.run("renderer-read", () => renderer.read()))
        ?.opaquePixels ?? 0;
    const pixels = async () =>
      (await session.run("renderer-read", () => renderer.read()))!.pixels;
    const initial = await session.run(
      "renderer-waitUntilReady",
      () => renderer.waitUntilReady({ paintedPixels: 1500 }),
      { timeout: 10000 },
    );
    expect(initial.scaleFactor).toBe(
      Number(process.env.MOSEY_TEST_SCALE_FACTOR ?? "1"),
    );
    if (phase === "main") {
      session.mark("main-process-crash");
      const children = await session.run("app-evaluate", () =>
        app.evaluate(({ app }) =>
          app
            .getAppMetrics()
            .map((metric) => metric.pid)
            .filter((pid) => pid !== process.pid),
        ),
      );
      const processHandle = app.process();
      const exited = session.run(
        "app-waitForEvent",
        () => app.waitForEvent("close"),
        { timeout: 10000 },
      );
      await session.run("app-evaluate", () =>
        app.evaluate(() => process.crash()).catch(() => {}),
      );
      await exited;
      expect(
        processHandle.exitCode !== 0 || processHandle.signalCode !== null,
      ).toBe(true);
      session.mark("main-process-children-exit");
      for (const pid of children) {
        await expect
          .poll(
            () => {
              try {
                process.kill(pid, 0);
                return false;
              } catch (error) {
                return (error as NodeJS.ErrnoException).code === "ESRCH";
              }
            },
            { timeout: 10000 },
          )
          .toBe(true);
      }
      return;
    }
    const expectedSize = phase === "preview" ? 200 : 240;
    if (phase === "preview") {
      const settings = await openSettings(app, { run: session.run });
      await session.run("settings-evaluate", () =>
        settings.evaluate(() => window.moseySettings.previewSize(200)),
      );
      // Wait for the resized paint before sampling a complete idle cycle.
      // The previous-size canvas can still contain opaque pixels meanwhile.
      await expect
        .poll(
          async () =>
            (await session.run("renderer-read", () => renderer.read()))?.width,
        )
        .toBe(expectedSize);
      await expect.poll(drawn).toBeGreaterThan(1500);
    }
    session.mark("reference-idle-pixels");
    const idleFrames = new Set<string>();
    const until = Date.now() + 2200;
    while (Date.now() < until) {
      const frame = (await session.run("renderer-read", () =>
        renderer.read(),
      ))!;
      idleFrames.add(frame.pixels);
      idleFrames.add(frame.mirroredPixels);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const matchesIdle = matchPaintedFrames(idleFrames, {
      maxChannelDifference: phase === "preview" ? 24 : 2,
    });
    const invoke = (label: string) =>
      session.run("app-evaluate", () =>
        app.evaluate(({ Menu }, label) => {
          const item = Menu.getApplicationMenu()!
            .items.find((item) => item.label === "Mosey")!
            .submenu!.items.find((item) => item.label === label);
          if (!item) throw new Error(`Missing menu: ${label}`);
          item.click();
        }, label),
      );
    const visible = () =>
      session.run("app-evaluate", () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey")!
            .isVisible(),
        ),
      );
    session.mark(`prepare-${phase}`);
    // Exercise real held and released gestures, plus a hidden renderer.
    if (phase === "hidden") await invoke("Hide Mosey");
    else if (phase === "walking" || phase === "sleeping") {
      // Advance only the injected behavior adapter; recovery deadlines stay real.
      await invoke("Hide Mosey");
      await invoke("Show Mosey");
      if (phase === "sleeping")
        await session.run("controlBehavior", () =>
          controlBehavior(app, { advanceBy: 180000 }),
        );
      else await advanceRest(app, 0.1, session.run);
      await expect
        .poll(async () => matchesIdle(await pixels()), {
          timeout: 5000,
          interval: 20,
        })
        .toBe(false);
      if (phase === "sleeping")
        await new Promise((resolve) => setTimeout(resolve, 1800));
    } else if (phase !== "preview") {
      await session.run("page-move", () => page.mouse.move(120, 180));
      await session.run("page-down", () => page.mouse.down());
      await session.run("page-move", () => page.mouse.move(120, -120));
      await expect
        .poll(() =>
          session.run("distanceFromGround", () => distanceFromGround(app)),
        )
        .not.toBe(0);
      if (phase === "falling") {
        await session.run("page-up", () => page.mouse.up());
        const held = await session.run("distanceFromGround", () =>
          distanceFromGround(app),
        );
        await expect
          .poll(
            () =>
              session.run("distanceFromGround", () => distanceFromGround(app)),
            { interval: 10 },
          )
          .toBeGreaterThan(held + 5);
      }
    }
    const recover = async () => {
      session.mark("automatic-recovery-crash");
      await session.run("renderer-crash", () => renderer.crash());
      session.mark("automatic-recovery-presentation");
      const recovered = await session.run(
        "renderer-waitUntilReady",
        () => renderer.waitUntilReady({ paintedPixels: 1500 }),
        { timeout: 10000 },
      );
      expect(recovered.visible).toBe(phase !== "hidden");
      expect(recovered.presentation.visibility).toBe(
        phase === "hidden" ? "hidden" : "visible",
      );
      expect(recovered.presentation.posture).toBe("resting");
      if (phase === "hidden") {
        // Hidden readiness must not show the pet just to acquire pixels.
        expect(
          JSON.parse(
            await session.run("readFile", () =>
              readFile(path.join(session.profile, "preferences.json"), "utf8"),
            ),
          ).visibility,
        ).toBe("hidden");
        await invoke("Show Mosey");
        const shown = await session.run(
          "renderer-waitUntilReady",
          () => renderer.waitUntilReady({ paintedPixels: 1500 }),
          { timeout: 10000 },
        );
        expect(matchesIdle(shown.pixels)).toBe(true);
      } else expect(matchesIdle(recovered.pixels)).toBe(true);
    };
    if (phase === "preview")
      await renderer.withColdImages(recover, session.run);
    else await recover();
    session.mark("recovered-motion-and-interaction");
    await expect
      .poll(() =>
        session.run("distanceFromGround", () => distanceFromGround(app)),
      )
      .toBe(0);
    // Wait past the interrupted short deadline: no overdue activity or
    // completion may displace the new resting renderer.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const recoveredPixels = await pixels();
    if (!matchesIdle(recoveredPixels)) {
      await session.run("mkdir", () =>
        mkdir("test-results", { recursive: true }),
      );
      await session.run("writeFile", () =>
        writeFile(
          `test-results/recovery-${phase}-${packaged ? "packaged" : "development"}.png`,
          Buffer.from(recoveredPixels.split(",")[1]!, "base64"),
        ),
      );
      const state = (await session.run("renderer-read", () => renderer.read()))
        ?.presentation;
      throw new Error(
        `Recovered canvas is not resting: ${JSON.stringify(state)}`,
      );
    }
    const presentation = (await session.run("renderer-read", () =>
      renderer.read(),
    ))!.presentation;
    expect(presentation.posture).toBe("resting");
    expect(presentation.size).toBe(expectedSize);
    expect(
      await session.run("distanceFromGround", () => distanceFromGround(app)),
    ).toBe(0);
    expect(
      await session.run("app-evaluate", () =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((window) => window.getTitle() === "Mosey")!
              .getBounds().width,
        ),
      ),
    ).toBe(expectedSize);
    await session.run("app-evaluate", () =>
      app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows().find(
          (window) => window.getTitle() === "Mosey",
        )!.webContents;
        contents.sendInputEvent({
          type: "mouseUp",
          button: "left",
          x: -100,
          y: -100,
        });
        contents.sendInputEvent({ type: "mouseMove", x: -100, y: -100 });
      }),
    );
    // No old capture/movement survives the recovered renderer.
    await expect
      .poll(() =>
        session.run("distanceFromGround", () => distanceFromGround(app)),
      )
      .toBe(0);
    await invoke("Hide Mosey");
    session.mark("second-renderer-failure");
    await session.run("renderer-crash", () => renderer.crash());
    await expect
      .poll(() =>
        session.run("app-evaluate", () =>
          app.evaluate(({ Menu }) =>
            Menu.getApplicationMenu()!
              .items.find((item) => item.label === "Mosey")!
              .submenu!.items.some((item) => item.label === "Retry Mosey"),
          ),
        ),
      )
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await visible()).toBe(false);
    expect(
      await session.run("app-evaluate", () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey")!
            .webContents.isCrashed(),
        ),
      ),
    ).toBe(true);
    const retry = async () => {
      session.mark("manual-retry-hidden");
      await invoke("Retry Mosey");
      // Keep the original cold-load ordering: show the new document before
      // atlas decode completes, then judge its first painted observation.
      const recovered = await session.run(
        "renderer-waitForDocument",
        () => renderer.waitForDocument(),
        { timeout: 1000 },
      );
      expect(recovered.visible).toBe(false);
      expect(recovered.presentation.visibility).toBe("hidden");
      expect(
        JSON.parse(
          await session.run("readFile", () =>
            readFile(path.join(session.profile, "preferences.json"), "utf8"),
          ),
        ).visibility,
      ).toBe("hidden");
      await invoke("Show Mosey");
      session.mark("manual-retry-first-paint");
      const shown = await session.run(
        "renderer-waitUntilReady",
        () => renderer.waitUntilReady({ paintedPixels: 1500 }),
        { timeout: 10000 },
      );
      expect(shown.visible).toBe(true);
      expect(matchesIdle(shown.pixels)).toBe(true);
    };
    if (phase === "preview") await renderer.withColdImages(retry, session.run);
    else await retry();
    await expect
      .poll(() =>
        session.run("distanceFromGround", () => distanceFromGround(app)),
      )
      .toBe(0);
    const logPath = await session.run("app-evaluate", () =>
      app.evaluate(({ app }) =>
        process
          .getBuiltinModule("node:path")
          .join(app.getPath("logs"), "main.log"),
      ),
    );
    expect(
      await session.run("readFile", () => readFile(logPath, "utf8")),
    ).toContain("Pet renderer exited");
    session.mark("final-renderer-failure");
    await session.run("renderer-crash", () => renderer.crash());
    await expect
      .poll(() =>
        session.run("app-evaluate", () =>
          app.evaluate(
            ({ BrowserWindow }) =>
              !BrowserWindow.getAllWindows()
                .find((window) => window.getTitle() === "Mosey")!
                .isVisible(),
          ),
        ),
      )
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      await session.run("app-evaluate", () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey")!
            .webContents.isCrashed(),
        ),
      ),
    ).toBe(true);
    session.mark("explicit-quit");
    const processHandle = app.process();
    const exited = session.run(
      "app-waitForEvent",
      () => app.waitForEvent("close"),
      { timeout: 10000 },
    );
    await invoke("Quit Mosey");
    await exited;
    expect(processHandle.exitCode).toBe(0);
  },
);
