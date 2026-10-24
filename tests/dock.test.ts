import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  chmod,
  rm,
  rename,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { chooseSize } from "./support/settings";
import { startForge } from "./support/forge";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
// Only the OS capture producer is substituted. The actual Electron window,
// behavior, renderer, atlas hit masks, native protocol and motion all run.
test("Dock support follows visible overlap, yields to dragging, avoids sides and respects hidden intent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-dock-"));
  let app: ElectronApplication | undefined;
  let stopForge: (() => Promise<void>) | undefined;
  let original: Buffer | undefined;
  let helper = "";
  let runtimeProvenance: unknown;
  let applicationStderrTail = "";
  let applicationProcess:
    ReturnType<ElectronApplication["process"]> | undefined;
  const input = path.join(root, "observation.json");
  const publishObservation = async (value: string) => {
    await writeFile(`${input}.next`, value);
    await rename(`${input}.next`, input);
  };
  await publishObservation("null");
  try {
    if (!packaged) stopForge = await startForge();
    else
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    helper = packaged
      ? path.join(root, "Mosey.app/Contents/Resources/native/dock-runtime")
      : path.resolve("build/native/dock-runtime");
    original = await readFile(helper).catch(() => undefined);
    await mkdir(path.dirname(helper), { recursive: true });
    await writeFile(
      helper,
      `#!${process.execPath}\nimport fs from 'node:fs';\nconst start = performance.now(); let sequence=0; fs.appendFileSync(${JSON.stringify(path.join(root, "pids.jsonl"))},process.pid+'\\n');\nconsole.log(JSON.stringify({type:'environment',protocol:1,processID:process.pid,parentPID:process.ppid}));\nsetInterval(()=>{ const value=JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8')); const pending=value?.testPending===true; const observation=pending?null:value; console.log(JSON.stringify({type:'observation',elapsed:(performance.now()-start)/1000,sequence:++sequence,sourceAgeSeconds:0,callbackAgeSeconds:0,idle:false,reason:pending?'new_complete_pending':observation?'current':'alpha_empty',observation})); },100);\n`,
    );
    await chmod(helper, 0o755);
    await mkdir(path.join(root, "profile"), { recursive: true });
    await writeFile(
      path.join(root, "profile/preferences.json"),
      JSON.stringify({ version: 2, visibility: "visible", size: 240 }),
    );
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [`--user-data-dir=${root}/profile`],
          }
        : { args: [".", `--user-data-dir=${root}/profile`] },
    );
    applicationProcess = app.process();
    applicationProcess.stderr?.on("data", (bytes: Buffer) => {
      applicationStderrTail = (
        applicationStderrTail + bytes.toString("utf8")
      ).slice(-8192);
    });
    try {
      const testSHA256 = createHash("sha256")
        .update(await readFile(path.resolve("tests/dock.test.ts")))
        .digest("hex");
      runtimeProvenance = await app.evaluate(({ app }, testSHA256) => {
        try {
          // Read through Electron's public fs so virtual app.asar paths work too.
          const fs = process.getBuiltinModule("node:fs");
          const path = process.getBuiltinModule("node:path");
          const crypto = process.getBuiltinModule("node:crypto");
          const hash = (value: Buffer | string) =>
            crypto.createHash("sha256").update(value).digest("hex");
          const appPath = app.getAppPath();
          const manifest = JSON.parse(
            fs.readFileSync(path.join(appPath, "package.json"), "utf8"),
          );
          const entry = path.resolve(appPath, manifest.main);
          const actualEntry = fs.realpathSync(entry);
          const bytes = fs.readFileSync(actualEntry);
          const text = bytes.toString("utf8");
          const markers: [string, RegExp][] = [
            ["Retry reason", /product Dock interaction requested/],
            ["Diagnostic stop method", /async stop\([^)]*,[^)]*\)\s*\{/],
            [
              "Stop reason assignment",
              /this\.stopReason\s*=\s*[A-Za-z_$][\w$]*/,
            ],
            [
              "Render request assignment",
              /[A-Za-z_$][\w$]*\.requestedHTML\s*=/,
            ],
            [
              "Render queue continuation",
              /[A-Za-z_$][\w$]*\.requestedHTML\s*!==/,
            ],
          ];
          const snippets = markers.map(([marker, pattern]) => {
            const offset = text.search(pattern);
            const snippet =
              offset < 0
                ? ""
                : text.slice(Math.max(0, offset - 80), offset + 560);
            return {
              marker,
              found: offset >= 0,
              snippet,
              sha256: hash(snippet),
            };
          });
          return {
            entryRelative: path.relative(appPath, entry),
            realEntryRelative: path.relative(
              fs.realpathSync(appPath),
              actualEntry,
            ),
            entrySHA256: hash(bytes),
            testSHA256,
            snippets,
          };
        } catch (error) {
          return { unavailable: String(error).slice(0, 500) };
        }
      }, testSHA256);
    } catch (error) {
      runtimeProvenance = { unavailable: String(error).slice(0, 500) };
    }
    const pet = await app.firstWindow();
    await pet.locator("canvas").waitFor();
    await pet.waitForLoadState("networkidle");
    await expect
      .poll(
        () =>
          pet.evaluate(() => {
            const canvas = document.querySelector("canvas")!;
            return Array.from(
              canvas
                .getContext("2d")!
                .getImageData(0, 0, canvas.width, canvas.height).data,
            ).filter((value, index) => index % 4 === 3 && value >= 128).length;
          }),
        { timeout: 15000 },
      )
      .toBeGreaterThan(5000);
    const petWindowID = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id,
    );
    const bounds = () =>
      app!.evaluate(
        ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getBounds(),
        petWindowID,
      );
    const display = await app.evaluate(({ screen }) =>
      screen.getPrimaryDisplay(),
    );
    const floor = display.workArea.y + display.workArea.height;
    const invokeMenu = (section: string, label: string) =>
      app!.evaluate(
        ({ Menu }, { section, label }) => {
          const item = Menu.getApplicationMenu()!
            .items.find((i) => i.label === section)!
            .submenu!.items.find((i) => i.label === label)!;
          const trace = Reflect.get(globalThis, "dockNavigationTrace");
          const record = (event: string, error?: unknown) => {
            if (!trace) return;
            trace.menuEvents.push({
              event,
              label,
              enabled: item.enabled,
              at: performance.now(),
              wall: Date.now(),
              error: error === undefined ? undefined : String(error),
            });
            if (trace.menuEvents.length > 128) trace.menuEvents.shift();
          };
          record("fresh-menu-entry");
          try {
            const result = item.click();
            record("fresh-menu-return");
            return result;
          } catch (error) {
            record("fresh-menu-throw", error);
            throw error;
          }
        },
        { section, label },
      );
    const invoke = (label: string) => invokeMenu("Mosey", label);
    const setDock = async (
      orientation: "bottom" | "left" | "right",
      start: number,
      end: number,
      inward: number,
    ) => {
      const contour = Array.from(
        { length: Math.ceil(end - start) },
        (_, i) => ({ axis: start + i, inward }),
      );
      const rectangle =
        orientation === "bottom"
          ? {
              x: start,
              y: inward,
              width: end - start,
              height: display.bounds.y + display.bounds.height - inward,
            }
          : orientation === "left"
            ? {
                x: display.bounds.x,
                y: start,
                width: inward - display.bounds.x,
                height: end - start,
              }
            : {
                x: inward,
                y: start,
                width: display.bounds.x + display.bounds.width - inward,
                height: end - start,
              };
      await publishObservation(
        JSON.stringify({
          orientation,
          bounds: rectangle,
          contour,
          primaryDisplayID: display.id,
        }),
      );
    };
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height)
      .toBe(floor);
    // Pending/null capture reports have never established Dock support. They
    // cannot undo placement recovered at an external display boundary.
    const displayRecoveryState = await app.evaluateHandle(
      ({ screen, BrowserWindow }, id) => {
        const pet = BrowserWindow.fromId(id)!;
        const original = screen.getPrimaryDisplay;
        const display = original();
        screen.getPrimaryDisplay = () => ({
          ...display,
          id: display.id + 1,
          workArea: {
            ...display.workArea,
            x: display.workArea.x + 40,
            y: display.workArea.y + 40,
            width: display.workArea.width - 80,
            height: display.workArea.height - 80,
          },
        });
        screen.emit("display-metrics-changed", {}, screen.getPrimaryDisplay(), [
          "workArea",
        ]);
        return {
          bounds: pet.getBounds(),
          restore: () => {
            screen.getPrimaryDisplay = original;
          },
        };
      },
      petWindowID,
    );
    // Keep the public display fixture active through the entire scenario,
    // including main's native-state reconciliation polls.
    const displayRecovery = await displayRecoveryState.evaluate(
      (state) => state.bounds,
    );
    await publishObservation(JSON.stringify({ testPending: true }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(
      await bounds(),
      "pending without previous Dock support preserves display recovery",
    ).toEqual(displayRecovery);
    await publishObservation("null");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      await bounds(),
      "null completion without previous Dock support preserves display recovery",
    ).toEqual(displayRecovery);
    await displayRecoveryState.evaluate((state) => state.restore());
    await displayRecoveryState.dispose();
    await app.evaluate(({ screen }) =>
      screen.emit("display-metrics-changed", {}, screen.getPrimaryDisplay(), [
        "workArea",
      ]),
    );
    const pixels = () =>
      pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL();
      });
    const idleFrames = new Set<string>();
    const idleUntil = Date.now() + 2200;
    while (Date.now() < idleUntil) {
      idleFrames.add(await pixels());
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const children = () =>
      execFileSync("/bin/ps", ["-Ao", "pid=,ppid=,command="], {
        encoding: "utf8",
      })
        .split("\n")
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
        .filter(
          (parts) => parts && Number(parts[2]) === applicationProcess!.pid,
        )
        .map((parts) => ({ pid: Number(parts![1]), command: parts![3]! }));
    const invokeDiagnostic = (label: string) =>
      invokeMenu("Dock validation", label);
    // Keep the owned product helper alive but stopped while the user selects
    // diagnostics then rapidly hides/shows. Capture ownership must be reserved
    // before its SIGKILL cleanup deadline, not after diagnostic startup.
    const productChild = children().find((item) =>
      item.command.endsWith("/dock-runtime"),
    );
    expect(productChild).toBeDefined();
    process.kill(productChild!.pid, "SIGSTOP");
    // Observe actual public navigation calls; never inspect the diagnostic's
    // internal render job. Replacing a live data document before loadURL settles
    // has crashed the packaged navigation host during Stop followed by Retry.
    const navigation = await app.evaluateHandle(
      ({ app, Menu, MenuItem, BrowserWindow, powerMonitor, screen }) => {
        const events: unknown[] = [];
        const menuEvents: unknown[] = [];
        const lifecycle: unknown[] = [];
        const childEvents: unknown[] = [];
        const state = {
          maxUnsettled: 0,
          events,
          menuEvents,
          lifecycle,
          childEvents,
        };
        Object.assign(globalThis, { dockNavigationTrace: state });
        const record = (rows: unknown[], event: string, detail?: unknown) => {
          rows.push({ event, detail, at: performance.now(), wall: Date.now() });
          if (rows.length > 128) rows.shift();
        };
        // Public ChildProcess event dispatch brackets the existing close handler.
        // No child is replaced, signalled or delayed by this observer.
        const { ChildProcess } = process.getBuiltinModule("node:child_process");
        const originalEmit = ChildProcess.prototype.emit;
        ChildProcess.prototype.emit = function (
          this: import("node:child_process").ChildProcess,
          event: string | symbol,
          ...args: unknown[]
        ) {
          if (event !== "close" && event !== "exit")
            return Reflect.apply(originalEmit, this, [event, ...args]);
          const detail = { pid: this.pid, code: args[0], signal: args[1] };
          record(childEvents, `child-${event}-entry`, detail);
          try {
            const result = Reflect.apply(originalEmit, this, [event, ...args]);
            record(childEvents, `child-${event}-return`, detail);
            return result;
          } catch (error) {
            record(childEvents, `child-${event}-throw`, {
              ...detail,
              error: String(error).slice(0, 500),
            });
            throw error;
          }
        };
        // Observe the supplied callback as well as MenuItem.click. Electron builds
        // submenus recursively, so never wrap an already observed callback twice.
        const observed = new WeakSet<
          NonNullable<Electron.MenuItemConstructorOptions["click"]>
        >();
        const originalBuild = Menu.buildFromTemplate;
        let nextHandlerID = 0;
        const isTemplate = (
          item: Electron.MenuItemConstructorOptions | Electron.MenuItem,
        ): item is Electron.MenuItemConstructorOptions =>
          !(item instanceof MenuItem);
        const observeTemplate = (
          item: Electron.MenuItemConstructorOptions,
        ): Electron.MenuItemConstructorOptions => {
          const copy = { ...item };
          if (Array.isArray(copy.submenu))
            copy.submenu = copy.submenu.map(observeTemplate);
          const handler = copy.click;
          if (handler && !observed.has(handler)) {
            const handlerID = ++nextHandlerID;
            let source = "";
            let handlerSHA256: string | undefined;
            let hashError: string | undefined;
            try {
              source = Function.prototype.toString.call(handler);
              handlerSHA256 = process
                .getBuiltinModule("node:crypto")
                .createHash("sha256")
                .update(source)
                .digest("hex");
            } catch (error) {
              hashError = String(error).slice(0, 500);
            }
            const identity = {
              label: item.label,
              handlerID,
              handlerSHA256,
              hashError,
            };
            const wrapped: typeof handler = function (this: unknown, ...args) {
              record(menuEvents, "template-handler-entry", {
                ...identity,
                source: source.slice(0, 768),
                sourceTruncated: source.length > 768,
              });
              try {
                const result = Reflect.apply(handler, this, args);
                record(menuEvents, "template-handler-return", identity);
                return result;
              } catch (error) {
                record(menuEvents, "template-handler-throw", {
                  ...identity,
                  error: String(error).slice(0, 500),
                });
                throw error;
              }
            };
            observed.add(wrapped);
            copy.click = wrapped;
          }
          return copy;
        };
        Menu.buildFromTemplate = function (this: typeof Menu, template) {
          return originalBuild.call(
            this,
            template.map((item) =>
              isTemplate(item) ? observeTemplate(item) : item,
            ),
          );
        };
        powerMonitor.on("suspend", () => record(lifecycle, "suspend"));
        powerMonitor.on("resume", () => record(lifecycle, "resume"));
        powerMonitor.on("lock-screen", () => record(lifecycle, "lock-screen"));
        powerMonitor.on("unlock-screen", () =>
          record(lifecycle, "unlock-screen"),
        );
        screen.on("display-metrics-changed", (_event, display, changed) =>
          record(lifecycle, "display-metrics-changed", {
            id: display.id,
            bounds: display.bounds,
            workArea: display.workArea,
            changed,
          }),
        );
        const observeWindow = (window: Electron.BrowserWindow) => {
          const id = window.id;
          window.on("show", () => record(lifecycle, "show", { id }));
          window.on("hide", () => record(lifecycle, "hide", { id }));
          window.on("closed", () => record(lifecycle, "closed", { id }));
        };
        BrowserWindow.getAllWindows().forEach(observeWindow);
        app.on("browser-window-created", (_event, window) =>
          observeWindow(window),
        );
        record(lifecycle, "attached", {
          // This value alone does not establish whether the session is unlocked.
          idleStateDiagnosticOnly: powerMonitor.getSystemIdleState(1),
          windows: BrowserWindow.getAllWindows().map((window) => ({
            id: window.id,
            visible: window.isVisible(),
          })),
        });
        app.once("browser-window-created", (_event, window) => {
          const contents = window.webContents;
          const windowID = window.id;
          const webContentsID = contents.id;
          const original = contents.loadURL.bind(contents);
          let unsettled = 0;
          contents.loadURL = (url, options) => {
            unsettled += 1;
            state.maxUnsettled = Math.max(state.maxUnsettled, unsettled);
            const status = decodeURIComponent(url).match(
              /<p role="status">([^<]*)<\/p>/,
            )?.[1];
            const record = (event: string, error?: unknown) => {
              state.events.push({
                event,
                status,
                windowID,
                webContentsID,
                at: performance.now(),
                wall: Date.now(),
                unsettled,
                error: error === undefined ? undefined : String(error),
              });
              if (state.events.length > 128) state.events.shift();
            };
            record("loadURL");
            return original(url, options)
              .then(
                () => {
                  record("loadURL-fulfilled");
                },
                (error: unknown) => {
                  record("loadURL-rejected", error);
                  throw error;
                },
              )
              .finally(() => {
                unsettled -= 1;
              });
          };
        });
        return state;
      },
    );
    const diagnosticWindow = app.waitForEvent("window");
    await invokeDiagnostic("Start Dock validation (120 seconds)");
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    const diagnostic = await diagnosticWindow;
    await diagnostic
      .getByRole("heading", { name: "Dock validation" })
      .waitFor();
    await expect
      .poll(() => diagnostic.locator("body").innerText(), { timeout: 15000 })
      .toMatch(
        /Capturing diagnostic statistics|Blocked: native screen-recording permission unavailable/,
      );
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(
      children().filter((item) => item.command.endsWith("/dock-runtime")),
    ).toEqual([]);
    await invokeDiagnostic("Stop Dock validation");
    await invoke("Retry Dock interaction");
    await expect
      .poll(
        () => children().some((item) => item.command.endsWith("/dock-runtime")),
        { timeout: 4000 },
      )
      .toBe(true);
    expect(await navigation.evaluate((state) => state.maxUnsettled)).toBe(1);
    await expect
      .poll(() => diagnostic.locator("body").innerText())
      .toContain("Stopped: product Dock interaction requested");
    const origin = await bounds();
    await setDock(
      "bottom",
      origin.x - 20,
      origin.x + origin.width + 20,
      floor - 75,
    );
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 5000,
      })
      .toBe(floor - 75);
    await pet.screenshot({
      path: `test-results/${packaged ? "packaged" : "development"}-dock-supported.png`,
      omitBackground: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // A worker processing a newer frame must not consume the old edge or
    // make the pet fall and re-climb between valid complete frames.
    await publishObservation(JSON.stringify({ testPending: true }));
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect((await bounds()).y + (await bounds()).height).toBe(floor - 75);
    expect(idleFrames.has(await pixels())).toBe(true);
    // A stuck worker cannot keep an old edge alive indefinitely.
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 3000,
      })
      .toBe(floor);
    await setDock(
      "bottom",
      origin.x - 20,
      origin.x + origin.width + 20,
      floor - 75,
    );
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 5000,
      })
      .toBe(floor - 75);
    // A visible Dock elsewhere cannot keep the pet elevated.
    await setDock(
      "bottom",
      display.bounds.x,
      display.bounds.x + 40,
      floor - 75,
    );
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 5000,
      })
      .toBe(floor);
    await setDock(
      "bottom",
      origin.x - 20,
      origin.x + origin.width + 20,
      floor - 75,
    );
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 5000,
      })
      .toBe(floor - 75);
    await publishObservation("null");
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 5000,
      })
      .toBe(floor);
    const size = (label: string) => chooseSize(app!, label);
    for (const [label, side] of [
      ["Small", 70],
      ["Medium", 160],
      ["Large", 240],
    ] as const) {
      await setDock(
        "bottom",
        display.bounds.x,
        display.bounds.x + display.bounds.width,
        floor - 60,
      );
      await size(label);
      await expect.poll(async () => (await bounds()).width).toBe(side);
      await expect
        .poll(async () => (await bounds()).y + (await bounds()).height, {
          timeout: 5000,
        })
        .toBe(floor - 60);
    }
    await size("Medium");
    await setDock(
      "bottom",
      display.bounds.x,
      display.bounds.x + display.bounds.width,
      floor - 75,
    );
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 5000,
      })
      .toBe(floor - 75);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const bodyPoint = () =>
      pet.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const rect = canvas.getBoundingClientRect();
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let best: { x: number; y: number; distance: number } | undefined;
        for (
          let y = Math.floor(canvas.height * 0.4);
          y < canvas.height * 0.85;
          y++
        )
          for (
            let x = Math.floor(canvas.width * 0.35);
            x < canvas.width * 0.65;
            x++
          ) {
            if (
              ![-6, 0, 6].every((dy) =>
                [-6, 0, 6].every(
                  (dx) =>
                    pixels[((y + dy) * canvas.width + x + dx) * 4 + 3]! >= 200,
                ),
              )
            )
              continue;
            const distance =
              (x - canvas.width * 0.5) ** 2 + (y - canvas.height * 0.65) ** 2;
            if (!best || distance < best.distance) best = { x, y, distance };
          }
        if (best)
          return {
            x: (best.x / canvas.width) * rect.width,
            y: (best.y / canvas.height) * rect.height,
          };
        throw new Error("No opaque body pixel");
      });
    const grab = await bodyPoint();
    await pet.mouse.move(grab.x, grab.y);
    await pet.mouse.down();
    await pet.mouse.move(grab.x, grab.y + 50);
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height)
      .toBeGreaterThan(floor - 40);
    const released = await bounds();
    await pet.mouse.up();
    // Releasing below the visible edge must climb from that location. It
    // cannot snap upwards when the falling phase first evaluates support.
    await new Promise((resolve) => setTimeout(resolve, 420));
    const returning = await bounds();
    expect(returning.y).toBeGreaterThan(released.y - 20);
    const regrab = await bodyPoint();
    await pet.mouse.move(regrab.x, regrab.y);
    await pet.mouse.down();
    await new Promise((resolve) => setTimeout(resolve, 70));
    const held = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(await bounds()).toEqual(held);
    await pet.mouse.up();
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 5000,
      })
      .toBe(floor - 75);
    await publishObservation("null");
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 5000,
      })
      .toBe(floor);
    // Side geometry changes x only, using the captured contour at body height.
    await setDock("left", floor - 250, floor, origin.x + 70);
    await expect
      .poll(async () => (await bounds()).x, { timeout: 3000 })
      .toBeGreaterThan(origin.x + 50);
    expect((await bounds()).y + (await bounds()).height).toBe(floor);
    await invoke("Hide Mosey");
    const hidden = await bounds();
    await setDock(
      "bottom",
      display.bounds.x,
      display.bounds.x + display.bounds.width,
      floor - 100,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      await app.evaluate(
        ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isVisible(),
        petWindowID,
      ),
    ).toBe(false);
    expect(await bounds()).toEqual(hidden);
    await invoke("Show Mosey");
    // The previous helper may still be closing when show arrives.
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 5000,
      })
      .toBe(floor - 100);
    await publishObservation("null");
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 5000,
      })
      .toBe(floor);
    // Accelerate only the known long rest deadline; movement clocks retain real
    // duration and the native cleanup/diagnostic deadlines remain untouched.
    await app.evaluate(() => {
      Math.random = () => 0.1;
      const original = globalThis.setTimeout;
      globalThis.setTimeout = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        original(
          callback,
          delay && delay >= 18000 && delay <= 32000 ? 1000 : delay,
          ...args,
        )) as typeof setTimeout;
    });
    const noSnapback = async () => {
      let prior = await bounds();
      await publishObservation("null");
      for (let sample = 0; sample < 16; sample++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const next = await bounds();
        expect(Math.abs(next.x - prior.x)).toBeLessThan(20);
        prior = next;
      }
    };
    for (const orientation of ["left", "right"] as const) {
      await invoke("Hide Mosey");
      await invoke("Show Mosey");
      const start = await bounds();
      await expect
        .poll(async () => Math.abs((await bounds()).x - start.x), {
          timeout: 4000,
          interval: 20,
        })
        .toBeGreaterThan(8);
      const moving = await bounds();
      await setDock(
        orientation,
        display.bounds.y,
        display.bounds.y + display.bounds.height,
        orientation === "left" ? moving.x + 100 : moving.x + moving.width - 100,
      );
      await expect
        .poll(
          async () =>
            orientation === "left"
              ? (await bounds()).x - moving.x
              : moving.x - (await bounds()).x,
          { timeout: 1500, interval: 20 },
        )
        .toBeGreaterThan(50);
      await noSnapback();
    }
    for (const orientation of ["left", "right"] as const) {
      await invoke("Hide Mosey");
      await invoke("Show Mosey");
      // Establish a fresh rendered pose after show, and keep this directed
      // drag out of the physical cursor's column. Real buttons=0 events from
      // that cursor otherwise cancel synthetic capture while the window moves.
      await app.evaluate(({ BrowserWindow, screen }, id) => {
        const pet = BrowserWindow.fromId(id)!;
        const area = screen.getPrimaryDisplay().workArea;
        const pointer = screen.getCursorScreenPoint();
        const margin = Math.min(200, (area.width - pet.getBounds().width) / 4);
        const x =
          pointer.x > area.x + area.width / 2
            ? area.x + margin
            : area.x + area.width - pet.getBounds().width - margin;
        pet.setPosition(Math.round(x), pet.getBounds().y, false);
      }, petWindowID);
      await new Promise((resolve) => setTimeout(resolve, 70));
      const point = await bodyPoint();
      await pet.mouse.move(point.x, point.y);
      await pet.mouse.down();
      await pet.mouse.move(point.x, point.y - 300);
      await expect
        .poll(async () => (await bounds()).y + (await bounds()).height)
        .toBeLessThan(floor - 250);
      const elevated = await bounds();
      await pet.mouse.up();
      await expect
        .poll(async () => (await bounds()).y, { interval: 10 })
        .toBeGreaterThan(elevated.y + 10);
      const moving = await bounds();
      await setDock(
        orientation,
        display.bounds.y,
        display.bounds.y + display.bounds.height,
        orientation === "left" ? moving.x + 100 : moving.x + moving.width - 100,
      );
      await expect
        .poll(
          async () =>
            orientation === "left"
              ? (await bounds()).x - moving.x
              : moving.x - (await bounds()).x,
          { timeout: 1000, interval: 10 },
        )
        .toBeGreaterThan(50);
      await noSnapback();
      await expect
        .poll(async () => (await bounds()).y + (await bounds()).height, {
          timeout: 3000,
        })
        .toBe(floor);
    }
    await mkdir("test-results", { recursive: true });
    await writeFile(
      `test-results/${packaged ? "packaged" : "development"}-dock.json`,
      JSON.stringify(
        {
          display,
          origin,
          runtimeProvenance,
          final: await bounds(),
          capture:
            "external synthetic native producer; no claim of physical Dock validation",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.log("Owned app at failure", {
      pid: applicationProcess?.pid,
      exitCode: applicationProcess?.exitCode,
      signalCode: applicationProcess?.signalCode,
      os: applicationProcess?.pid
        ? (() => {
            try {
              return execFileSync(
                "/bin/ps",
                [
                  "-p",
                  String(applicationProcess!.pid),
                  "-o",
                  "state=,command=",
                ],
                { encoding: "utf8" },
              ).trim();
            } catch {
              return "exited";
            }
          })()
        : "not launched",
    });
    console.log(
      "Owned windows at failure",
      await app
        ?.evaluate(({ BrowserWindow, screen, powerMonitor }) => ({
          windows: BrowserWindow.getAllWindows().map((window) => ({
            id: window.id,
            visible: window.isVisible(),
            bounds: window.getBounds(),
            url: window.webContents.getURL(),
            loading: window.webContents.isLoading(),
          })),
          display: screen.getPrimaryDisplay(),
          idleState: powerMonitor.getSystemIdleState(1),
        }))
        .catch(() => undefined),
      await app
        ?.windows()[0]
        ?.evaluate(async () => ({
          presentation: await window.mosey.getPresentation(),
          visibility: document.visibilityState,
          readyState: document.readyState,
          scripts: Array.from(document.scripts, (script) => script.src),
        }))
        .catch(() => undefined),
    );
    console.log(
      "Dock menu at failure",
      await app
        ?.evaluate(({ Menu }) =>
          Menu.getApplicationMenu()?.items.map((item) => ({
            label: item.label,
            submenu: item.submenu?.items.map((i) => i.label),
          })),
        )
        .catch(() => undefined),
    );
    await mkdir("test-results", { recursive: true });
    const navigationState = await app
      ?.evaluate(async ({ app, BrowserWindow }) => ({
        ...(Reflect.get(globalThis, "dockNavigationTrace") ?? {
          unavailable: "navigation trace not attached",
        }),
        publicWindows: await Promise.all(
          BrowserWindow.getAllWindows()
            .slice(0, 4)
            .map(async (window) => {
              const contents = window.webContents;
              const url = contents.getURL();
              const diagnostic = await contents
                .executeJavaScript(
                  `({status: document.querySelector('p[role="status"]')?.textContent, localLog: document.querySelector('input[aria-label="Local log"]')?.value})`,
                )
                .catch((error: unknown) => ({
                  unavailable: String(error).slice(0, 500),
                }));
              let localLogEvidence: unknown;
              if (typeof diagnostic.localLog === "string") {
                try {
                  const fs = process.getBuiltinModule("node:fs");
                  const path = process.getBuiltinModule("node:path");
                  const crypto = process.getBuiltinModule("node:crypto");
                  const expected = fs.realpathSync(
                    path.join(app.getPath("userData"), "dock-validation"),
                  );
                  const file = fs.realpathSync(diagnostic.localLog);
                  if (
                    path.dirname(file) !== expected ||
                    !/^run-[\da-f-]+\.jsonl$/.test(path.basename(file))
                  )
                    throw new Error("Local diagnostic log identity mismatch");
                  if (fs.statSync(file).size > 8 * 1024 * 1024)
                    throw new Error(
                      "Local diagnostic log exceeds existing bound",
                    );
                  const bytes = fs.readFileSync(file);
                  const records = bytes
                    .toString("utf8")
                    .trim()
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => JSON.parse(line));
                  const host = records.find(
                    (row) => row.type === "electron-host",
                  );
                  if (host?.processID !== process.pid)
                    throw new Error("Local diagnostic host PID mismatch");
                  const native = records.find(
                    (row) =>
                      row.type === "native" &&
                      row.record?.type === "environment",
                  );
                  const stops = records.filter(
                    (row) => row.type === "electron-stop",
                  );
                  localLogEvidence = {
                    basename: path.basename(file),
                    sha256: crypto
                      .createHash("sha256")
                      .update(bytes)
                      .digest("hex"),
                    hostPID: host.processID,
                    nativePID: native?.record.processID,
                    nativeParentPID: native?.record.parentPID,
                    nativeEnvironmentReceivedAt: native?.receivedAtMonotonicMs,
                    stopRecordCount: stops.length,
                    stops: stops.slice(-3).map((row) => ({
                      code: row.code,
                      signal: row.signal,
                      reason: String(row.reason).slice(0, 200),
                    })),
                    limitation:
                      "Stop records have no close timestamp; align nativePID with the public childEvents trace",
                  };
                } catch (error) {
                  localLogEvidence = {
                    unavailable: String(error).slice(0, 500),
                  };
                }
              }
              return {
                windowID: window.id,
                webContentsID: contents.id,
                url: url.slice(0, 2000),
                urlTruncated: url.length > 2000,
                visible: window.isVisible(),
                loading: contents.isLoading(),
                status: diagnostic.status ?? diagnostic.unavailable,
                localLogEvidence,
              };
            }),
        ),
      }))
      .catch((failure: unknown) => ({ unavailable: String(failure) }));
    await writeFile(
      `test-results/failure-${packaged ? "packaged" : "development"}-dock-navigation.json`,
      JSON.stringify(
        {
          runtimeProvenance,
          applicationStderrTail,
          ...(navigationState ?? {
            unavailable: "navigation trace not attached",
          }),
        },
        null,
        2,
      ),
    );
    await app
      ?.windows()[0]
      ?.screenshot({
        path: `test-results/failure-${packaged ? "packaged" : "development"}-dock.png`,
        timeout: 3000,
      })
      .catch(() => {});
    throw error;
  } finally {
    await app?.close().catch(() => {});
    if (!packaged && helper) {
      if (original) await writeFile(helper, original);
      else await rm(helper, { force: true });
    }
    await stopForge?.();
    await rm(root, { recursive: true, force: true });
  }
});

// This test keeps the compiled native helper intact. It can prove permission
// refusal or live transport cleanup on this host, without fabricating Dock pixels.
test("real Dock helper clears its capability and exits when transport stops or the pet hides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-real-dock-"));
  let app: ElectronApplication | undefined;
  let stopForge: (() => Promise<void>) | undefined;
  let helperPID: number | undefined;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const child = () => {
    const parent = app!.process().pid;
    const records = execFileSync("/bin/ps", ["-Ao", "pid=,ppid=,command="], {
      encoding: "utf8",
    });
    const record = records
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
      .find(
        (parts) =>
          parts &&
          Number(parts[2]) === parent &&
          parts[3]!.endsWith("/dock-runtime"),
      );
    return record ? Number(record[1]) : undefined;
  };
  try {
    if (!packaged) stopForge = await startForge();
    else
      execFileSync("/usr/bin/ditto", [
        path.resolve("out/Mosey-darwin-arm64/Mosey.app"),
        path.join(root, "Mosey.app"),
      ]);
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [`--user-data-dir=${root}/profile`],
          }
        : { args: [".", `--user-data-dir=${root}/profile`] },
    );
    const pet = await app.firstWindow();
    await pet.locator("canvas").waitFor();
    await pet.waitForLoadState("networkidle");
    const menuStatus = () =>
      app!.evaluate(
        ({ Menu }) =>
          Menu.getApplicationMenu()!
            .items.find((i) => i.label === "Mosey")!
            .submenu!.items.find((i) => !i.enabled)!.label,
      );
    const invoke = (label: string) =>
      app!.evaluate(
        ({ Menu }, label) =>
          Menu.getApplicationMenu()!
            .items.find((i) => i.label === "Mosey")!
            .submenu!.items.find((i) => i.label === label)!
            .click(),
        label,
      );
    await expect
      .poll(menuStatus, { timeout: 15000, interval: 40 })
      .not.toBe("Checking Dock capture permission");
    const initialStatus = await menuStatus();
    helperPID = child();
    const permissionBlocked = initialStatus.includes(
      "needs Screen Recording permission",
    );
    let faultInjected = false;
    if (permissionBlocked) {
      expect(helperPID).toBeUndefined();
    } else {
      expect(helperPID).toBeDefined();
      process.kill(helperPID!, "SIGSTOP");
      faultInjected = true;
      await expect
        .poll(menuStatus, { timeout: 4000, interval: 30 })
        .toBe("Dock capture heartbeat unavailable");
    }
    await invoke("Hide Mosey");
    if (helperPID)
      await expect.poll(() => alive(helperPID!), { timeout: 4000 }).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(child()).toBeUndefined();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isVisible(),
      ),
    ).toBe(false);
    await invoke("Show Mosey");
    await expect
      .poll(menuStatus, { timeout: 15000, interval: 40 })
      .not.toBe("Checking Dock capture permission");
    const restarted = child();
    await app.close();
    app = undefined;
    if (restarted)
      await expect.poll(() => alive(restarted), { timeout: 4000 }).toBe(false);
    await mkdir("test-results", { recursive: true });
    await writeFile(
      `test-results/${packaged ? "packaged" : "development"}-real-dock.json`,
      JSON.stringify(
        {
          initialStatus,
          permissionBlocked,
          faultInjected,
          helperPID,
          restarted,
          evidence:
            "real compiled helper; Playwright launch responsibility; no physical Dock geometry or independent LaunchServices permission claim",
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
        path: `test-results/failure-${packaged ? "packaged" : "development"}-real-dock.png`,
        timeout: 3000,
      })
      .catch(() => {});
    throw error;
  } finally {
    await app?.close().catch(() => {});
    await stopForge?.();
    await rm(root, { recursive: true, force: true });
  }
});
