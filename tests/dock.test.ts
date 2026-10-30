import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile, rename } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createPetTestSession } from "./support/pet-session";
import { controlBehavior, advanceRest } from "./support/controlled-behavior";

const whale = process.env.MOSEY_TEST_CHARACTER === "whale";
// Only the OS capture producer is substituted. The actual Electron window,
// behavior, renderer, atlas hit masks, native protocol and motion all run.
test("Dock support follows visible overlap, yields to dragging, avoids sides and respects hidden intent", async () => {
  let input = "";
  const session = await createPetTestSession({
    behavior: { random: 0.1 },
    preferences: {
      version: 3,
      character: whale ? "whale" : "corgi",
      visibility: "visible",
      size: 240,
    },
    dock: {
      name: "geometry-and-pending-script",
      async prepare({ root, evidence, run }) {
        input = path.join(root, "observation.json");
        await run("initial-dock-input", () => writeFile(input, "null"));
        return `#!${process.execPath}
import fs from 'node:fs';
const start = performance.now(); let sequence=0;
const record = (event, detail = {}) => fs.appendFileSync(${JSON.stringify(path.join(evidence, "producer-events.jsonl"))},JSON.stringify({event,pid:process.pid,ppid:process.ppid,...detail})+'\\n');
record('spawn');
process.on('exit', code => record('exit', {code}));
process.on('SIGTERM', () => process.exit(0));
console.log(JSON.stringify({type:'environment',protocol:1,processID:process.pid,parentPID:process.ppid}));
setInterval(()=>{ const value=JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8')); const pending=value?.testPending===true; const observation=pending?null:value; console.log(JSON.stringify({type:'observation',elapsed:(performance.now()-start)/1000,sequence:++sequence,sourceAgeSeconds:0,callbackAgeSeconds:0,idle:false,reason:pending?'new_complete_pending':observation?'current':'alpha_empty',observation})); },100);
`;
      },
    },
  });
  const { app, pet } = await session.launch();
  const applicationProcess = app.process();
  let runtimeProvenance: unknown;
  const publishObservation = async (value: string) => {
    await session.run("dock-input-write", () =>
      writeFile(`${input}.next`, value),
    );
    await session.run("dock-input-publish", () =>
      rename(`${input}.next`, input),
    );
  };
  try {
    try {
      const testSHA256 = createHash("sha256")
        .update(
          await session.run("readFile", () =>
            readFile(path.resolve("tests/dock.test.ts")),
          ),
        )
        .digest("hex");
      runtimeProvenance = await session.run("app.evaluate", () =>
        app.evaluate(({ app }, testSHA256) => {
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
        }, testSHA256),
      );
    } catch (error) {
      runtimeProvenance = { unavailable: String(error).slice(0, 500) };
    }
    await expect
      .poll(
        () =>
          session.run("pet.evaluate", () =>
            pet.evaluate(() => {
              const canvas = document.querySelector("canvas")!;
              return Array.from(
                canvas
                  .getContext("2d")!
                  .getImageData(0, 0, canvas.width, canvas.height).data,
              ).filter((value, index) => index % 4 === 3 && value >= 128)
                .length;
            }),
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(5000);
    const petWindowID = await session.run("app.evaluate", () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id),
    );
    const bounds = () =>
      session.run("app-.evaluate", () =>
        app!.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getBounds(),
          petWindowID,
        ),
      );
    let groundSamples = 0;
    const groundOffset = async () => {
      // A native work-area update can arrive after startup or without its event.
      // Observe the current ground and actual window in the same driver action.
      const sample = await session.run("observe-current-ground", () =>
        app.evaluate(({ BrowserWindow, screen }, id) => {
          const bounds = BrowserWindow.fromId(id)!.getBounds();
          const workArea = screen.getPrimaryDisplay().workArea;
          return {
            at: performance.now(),
            bounds,
            workArea,
            footY: bounds.y + bounds.height,
            floor: workArea.y + workArea.height,
          };
        }, petWindowID),
      );
      if (groundSamples++ < 128)
        await session.run("record-current-ground", () =>
          appendFile(
            path.join(session.evidence, "ground-placement.jsonl"),
            `${JSON.stringify(sample)}\n`,
          ),
        );
      return sample.footY - sample.floor;
    };
    const display = await session.run("app.evaluate", () =>
      app.evaluate(({ screen }) => screen.getPrimaryDisplay()),
    );
    // Synthetic Dock coordinates stay fixed; ordinary ground assertions below
    // use the current work area instead of this early display snapshot.
    const floor = display.workArea.y + display.workArea.height;
    const invokeMenu = async (section: string, label: string) => {
      // Input requires a currently available public menu item. Native menu
      // replacement can finish after a prior show/hide operation returns.
      await expect
        .poll(
          () =>
            session.run("app-.evaluate", () =>
              app!.evaluate(
                ({ Menu }, { section, label }) =>
                  Menu.getApplicationMenu()
                    ?.items.find((item) => item.label === section)
                    ?.submenu?.items.some(
                      (item) => item.label === label && item.enabled,
                    ) ?? false,
                { section, label },
              ),
            ),
          { timeout: 1000 },
        )
        .toBe(true);
      return session.run("app-.evaluate", () =>
        app!.evaluate(
          ({ Menu }, { section, label }) =>
            new Promise<void>((resolve, reject) => {
              // Dispatch on an application turn instead of executing user input
              // inside the inspector evaluation's interrupted native callback.
              setImmediate(() => {
                try {
                  const item = Menu.getApplicationMenu()!
                    .items.find((item) => item.label === section)!
                    .submenu!.items.find((item) => item.label === label);
                  if (!item || !item.enabled)
                    throw new Error(
                      `Menu item unavailable: ${section} / ${label}`,
                    );
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
                    item.click();
                    record("fresh-menu-return");
                    resolve();
                  } catch (error) {
                    record("fresh-menu-throw", error);
                    reject(error);
                  }
                } catch (error) {
                  reject(error);
                }
              });
            }),
          { section, label },
        ),
      );
    };
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
    await expect.poll(groundOffset).toBe(0);
    // Pending/null capture reports have never established Dock support. They
    // cannot undo placement recovered at an external display boundary.
    const displayRecoveryState = await session.run("app.evaluateHandle", () =>
      app.evaluateHandle(({ screen, BrowserWindow }, id) => {
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
      }, petWindowID),
    );
    // Keep the public display fixture active through the entire scenario,
    // including main's native-state reconciliation polls.
    const displayRecovery = await session.run(
      "displayRecoveryState.evaluate",
      () => displayRecoveryState.evaluate((state) => state.bounds),
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
    await session.run("displayRecoveryState.evaluate", () =>
      displayRecoveryState.evaluate((state) => state.restore()),
    );
    await session.run("displayRecoveryState.dispose", () =>
      displayRecoveryState.dispose(),
    );
    await session.run("app.evaluate", () =>
      app.evaluate(({ screen }) =>
        screen.emit("display-metrics-changed", {}, screen.getPrimaryDisplay(), [
          "workArea",
        ]),
      ),
    );
    const pixels = () =>
      session.run("pet.evaluate", () =>
        pet.evaluate(() => {
          const canvas = document.querySelector("canvas")!;
          canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height);
          return canvas.toDataURL();
        }),
      );
    const idleFrames = new Set<string>();
    const idleUntil = Date.now() + (whale ? 3100 : 2200);
    while (Date.now() < idleUntil) {
      idleFrames.add(await pixels());
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const children = () =>
      session.run("owned-producer-processes", async () =>
        execFileSync("/bin/ps", ["-Ao", "pid=,ppid=,command="], {
          encoding: "utf8",
          timeout: 5000,
        })
          .split("\n")
          .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
          .filter(
            (parts) => parts && Number(parts[2]) === applicationProcess!.pid,
          )
          .map((parts) => ({ pid: Number(parts![1]), command: parts![3]! })),
      );
    const invokeDiagnostic = (label: string) =>
      invokeMenu("Dock validation", label);
    // Keep the owned product helper alive but stopped while the user selects
    // diagnostics then rapidly hides/shows. Capture ownership must be reserved
    // before its SIGKILL cleanup deadline, not after diagnostic startup.
    const productChild = (await children()).find((item) =>
      item.command.endsWith("/dock-runtime"),
    );
    expect(productChild).toBeDefined();
    await session.run("stop-owned-product-transport", async () => {
      process.kill(productChild!.pid, "SIGSTOP");
    });
    // Observe actual public navigation calls; never inspect the diagnostic's
    // internal render job. Replacing a live data document before loadURL settles
    // has crashed the packaged navigation host during Stop followed by Retry.
    const navigation = await session.run("app.evaluateHandle", () =>
      app.evaluateHandle(
        (
          { app, Menu, MenuItem, BrowserWindow, powerMonitor, screen },
          output,
        ) => {
          let evidenceBytes = 0;
          const append = (event: unknown) => {
            const line = JSON.stringify(event) + "\n";
            if (evidenceBytes + Buffer.byteLength(line) > 256 * 1024) return;
            process.getBuiltinModule("node:fs").appendFileSync(output, line);
            evidenceBytes += Buffer.byteLength(line);
          };
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
            const entry = {
              event,
              detail,
              at: performance.now(),
              wall: Date.now(),
            };
            rows.push(entry);
            append(entry);
            if (rows.length > 128) rows.shift();
          };
          // Public ChildProcess event dispatch brackets the existing close handler.
          // No child is replaced, signalled or delayed by this observer.
          const { ChildProcess } =
            process.getBuiltinModule("node:child_process");
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
              const result = Reflect.apply(originalEmit, this, [
                event,
                ...args,
              ]);
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
              const wrapped: typeof handler = function (
                this: unknown,
                ...args
              ) {
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
          powerMonitor.on("lock-screen", () =>
            record(lifecycle, "lock-screen"),
          );
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
                append(state.events.at(-1));
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
        path.join(session.evidence, "dock-navigation.jsonl"),
      ),
    );
    const diagnosticWindow = session.run("app.waitForEvent", () =>
      app.waitForEvent("window"),
    );
    await invokeDiagnostic("Start Dock validation (120 seconds)");
    await invoke("Hide Mosey");
    await invoke("Show Mosey");
    const diagnostic = await diagnosticWindow;
    await session.run("diagnostic-heading", () =>
      diagnostic
        .getByRole("heading", { name: "Dock validation" })
        .waitFor({ timeout: 5000 }),
    );
    await expect
      .poll(
        () =>
          session.run("diagnostic.locator--body--.innerText", () =>
            diagnostic.locator("body").innerText(),
          ),
        { timeout: 15000 },
      )
      .toMatch(
        /Capturing diagnostic statistics|Blocked: native screen-recording permission unavailable/,
      );
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(
      (await children()).filter((item) =>
        item.command.endsWith("/dock-runtime"),
      ),
    ).toEqual([]);
    await invokeDiagnostic("Stop Dock validation");
    await invoke("Retry Dock interaction");
    await expect
      .poll(
        async () =>
          (await children()).some((item) =>
            item.command.endsWith("/dock-runtime"),
          ),
        { timeout: 4000 },
      )
      .toBe(true);
    expect(
      await session.run("navigation.evaluate", () =>
        navigation.evaluate((state) => state.maxUnsettled),
      ),
    ).toBe(1);
    await expect
      .poll(() =>
        session.run("diagnostic.locator--body--.innerText", () =>
          diagnostic.locator("body").innerText(),
        ),
      )
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
    await session.run("pet.screenshot", () =>
      pet.screenshot({
        path: path.join(session.evidence, "dock-supported.png"),
        omitBackground: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // Keep the existing Dock edge fixed while the ordinary ground changes by
    // one point, as it can during native startup. Omit the notification so an
    // expired worker must fall to the live ground, not a cached startup floor.
    const changedGround = await session.run("changed-ground-fixture", () =>
      app.evaluateHandle(({ screen }) => {
        const original = screen.getPrimaryDisplay;
        const initial = original();
        screen.getPrimaryDisplay = () => ({
          ...initial,
          workArea: {
            ...initial.workArea,
            height: initial.workArea.height - 1,
          },
        });
        return {
          restore: () => {
            screen.getPrimaryDisplay = original;
          },
        };
      }),
    );
    // A worker processing a newer frame must not consume the old edge or
    // make the pet fall and re-climb between valid complete frames.
    await publishObservation(JSON.stringify({ testPending: true }));
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect((await bounds()).y + (await bounds()).height).toBe(floor - 75);
    expect(idleFrames.has(await pixels())).toBe(true);
    // A stuck worker cannot keep an old edge alive indefinitely.
    await expect
      .poll(groundOffset, {
        timeout: 3000,
      })
      .toBe(0);
    await session.run("changed-ground-restore", () =>
      changedGround.evaluate((state) => state.restore()),
    );
    await session.run("changed-ground-dispose", () => changedGround.dispose());
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
      .poll(groundOffset, {
        timeout: 5000,
      })
      .toBe(0);
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
      .poll(groundOffset, {
        timeout: 5000,
      })
      .toBe(0);
    const size = async (label: string) => {
      const opened = session.run(
        "size-settings-window",
        () => app.waitForEvent("window", { timeout: 15000 }),
        { timeout: 15000 },
      );
      await invoke("设置…");
      const settings = await opened;
      await session.run(
        "size-settings-controls",
        () =>
          settings
            .getByRole("button", { name: "中（默认）", exact: true })
            .waitFor({ timeout: 15000 }),
        { timeout: 15000 },
      );
      await expect
        .poll(
          () =>
            session.run("size-settings-presentation", () =>
              app.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows().some(
                  (window) =>
                    window.getTitle() === "Mosey 设置" && window.isVisible(),
                ),
              ),
            ),
          { timeout: 15000 },
        )
        .toBe(true);
      await session.run(
        "size-settings-ready",
        () =>
          settings
            .getByText("正在读取系统状态…", { exact: true })
            .waitFor({ state: "hidden", timeout: 15000 }),
        { timeout: 15000 },
      );
      await session.run("size-settings-visible", () =>
        settings
          .getByRole("button", {
            name: (
              { Small: "小", Medium: "中（默认）", Large: "大" } as Record<
                string,
                string
              >
            )[label]!,
            exact: true,
          })
          .click(),
      );
      const closed = session.run("size-settings-closed", () =>
        settings.waitForEvent("close", { timeout: 5000 }),
      );
      await session.run("size-settings-close", () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Mosey 设置")!
            .close(),
        ),
      );
      await closed;
    };
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
      session.run("pet.evaluate", () =>
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
                      pixels[((y + dy) * canvas.width + x + dx) * 4 + 3]! >=
                      200,
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
        }),
      );
    const grab = await bodyPoint();
    await session.run("pet.mouse.move", () => pet.mouse.move(grab.x, grab.y));
    await session.run("pet.mouse.down", () => pet.mouse.down());
    await session.run("pet.mouse.move", () =>
      pet.mouse.move(grab.x, grab.y + 50),
    );
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height)
      .toBeGreaterThan(floor - 40);
    const released = await bounds();
    await session.run("pet.mouse.up", () => pet.mouse.up());
    // Releasing below the visible edge must climb from that location. It
    // cannot snap upwards when the falling phase first evaluates support.
    await new Promise((resolve) => setTimeout(resolve, 420));
    const returning = await bounds();
    expect(returning.y).toBeGreaterThan(released.y - 20);
    const regrab = await bodyPoint();
    await session.run("pet.mouse.move", () =>
      pet.mouse.move(regrab.x, regrab.y),
    );
    await session.run("pet.mouse.down", () => pet.mouse.down());
    await new Promise((resolve) => setTimeout(resolve, 70));
    const held = await bounds();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(await bounds()).toEqual(held);
    await session.run("pet.mouse.up", () => pet.mouse.up());
    await expect
      .poll(async () => (await bounds()).y + (await bounds()).height, {
        timeout: 5000,
      })
      .toBe(floor - 75);
    await publishObservation("null");
    await expect
      .poll(groundOffset, {
        timeout: 5000,
      })
      .toBe(0);
    // Side geometry changes x only, using the captured contour at body height.
    await setDock("left", floor - 250, floor, origin.x + 70);
    await expect
      .poll(async () => (await bounds()).x, { timeout: 3000 })
      .toBeGreaterThan(origin.x + 50);
    expect(await groundOffset()).toBe(0);
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
      await session.run("app.evaluate", () =>
        app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isVisible(),
          petWindowID,
        ),
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
      .poll(groundOffset, {
        timeout: 5000,
      })
      .toBe(0);
    // Only behavior time advances; native cleanup and diagnostic deadlines stay real.
    await session.run("walking-choice", () =>
      controlBehavior(app, { random: 0.1 }),
    );
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
      await advanceRest(app, 0.1, session.run);
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
      await session.run("app.evaluate", () =>
        app.evaluate(({ BrowserWindow, screen }, id) => {
          const pet = BrowserWindow.fromId(id)!;
          const area = screen.getPrimaryDisplay().workArea;
          const pointer = screen.getCursorScreenPoint();
          const margin = Math.min(
            200,
            (area.width - pet.getBounds().width) / 4,
          );
          const x =
            pointer.x > area.x + area.width / 2
              ? area.x + margin
              : area.x + area.width - pet.getBounds().width - margin;
          pet.setPosition(Math.round(x), pet.getBounds().y, false);
        }, petWindowID),
      );
      await new Promise((resolve) => setTimeout(resolve, 70));
      const point = await bodyPoint();
      await session.run("pet.mouse.move", () =>
        pet.mouse.move(point.x, point.y),
      );
      await session.run("pet.mouse.down", () => pet.mouse.down());
      await session.run("pet.mouse.move", () =>
        pet.mouse.move(point.x, point.y - 300),
      );
      await expect
        .poll(async () => (await bounds()).y + (await bounds()).height)
        .toBeLessThan(floor - 250);
      const elevated = await bounds();
      await session.run("pet.mouse.up", () => pet.mouse.up());
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
        .poll(groundOffset, {
          timeout: 3000,
        })
        .toBe(0);
    }
    const finalBounds = await bounds();
    await session.run("writeFile", () =>
      writeFile(
        path.join(session.evidence, "dock.json"),
        JSON.stringify(
          {
            display,
            origin,
            runtimeProvenance,
            final: finalBounds,
            capture:
              "external synthetic native producer; no claim of physical Dock validation",
          },
          null,
          2,
        ),
      ),
    );
    await session.quit();
    const producerRows = (
      await session.run("producer-exit-ledger", () =>
        readFile(path.join(session.evidence, "producer-events.jsonl"), "utf8"),
      )
    )
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    const childRows = (
      await session.run("public-child-exits", () =>
        readFile(path.join(session.evidence, "dock-navigation.jsonl"), "utf8"),
      )
    )
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    const pids = producerRows
      .filter((row) => row.event === "spawn")
      .map((row) => row.pid);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      expect(
        producerRows.some(
          (row) => row.event === "exit" && row.pid === pid && row.code === 0,
        ) ||
          childRows.some(
            (row) =>
              row.event === "child-exit-entry" &&
              row.detail.pid === pid &&
              (row.detail.code !== null || row.detail.signal !== null),
          ),
        `producer ${pid} has a normal exit event or an observed child-process exit`,
      ).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    }
    await session.run("producer-cleanup-evidence", () =>
      writeFile(
        path.join(session.evidence, "producer-cleanup.json"),
        JSON.stringify({ pids, allExited: true }),
      ),
    );
  } finally {
    await session.close();
  }
});

// This test keeps the compiled native helper intact. It can prove permission
// refusal or live transport cleanup on this host, without fabricating Dock pixels.
test("real Dock helper clears its capability and exits when transport stops or the pet hides", async () => {
  const session = await createPetTestSession({ dock: "real" });
  const { app } = await session.launch();
  let helperPID: number | undefined;
  const readiness: { status: string; pid?: number }[] = [];
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const child = () =>
    session.run("real-product-process", async () => {
      const parent = app!.process().pid;
      const records = execFileSync("/bin/ps", ["-Ao", "pid=,ppid=,command="], {
        encoding: "utf8",
        timeout: 5000,
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
    });
  try {
    const menuStatus = () =>
      session.run("app-.evaluate", () =>
        app!.evaluate(
          ({ Menu }) =>
            Menu.getApplicationMenu()!.getMenuItemById("dock-runtime-status")!
              .label,
        ),
      );
    const invoke = (label: string) =>
      session.run("app-.evaluate", () =>
        app!.evaluate(
          ({ Menu }, label) =>
            Menu.getApplicationMenu()!
              .items.find((i) => i.label === "Mosey")!
              .submenu!.items.find((i) => i.label === label)!
              .click(),
          label,
        ),
      );
    const waitForCapability = async () => {
      let observed: { status: string; pid?: number } = { status: "" };
      await expect
        .poll(
          async () => {
            observed = { status: await menuStatus(), pid: await child() };
            const previous = readiness.at(-1);
            if (
              previous?.status !== observed.status ||
              previous?.pid !== observed.pid
            )
              readiness.push(observed);
            // Loading/visibility reconciliation may legitimately leave Stopped
            // before capture starts. A negative "not checking" assertion is
            // not a capability: require a native result and, unless refused,
            // the actual direct child before injecting a transport fault.
            return (
              (observed.status ===
                "Dock interaction needs Screen Recording permission" &&
                observed.pid === undefined) ||
              ([
                "Dock interaction active",
                "Dock interaction waiting for visible Dock",
                "Dock source suspended; waiting for updates",
                "Updating Dock edge",
              ].includes(observed.status) &&
                observed.pid !== undefined)
            );
          },
          { timeout: 15000, interval: 40 },
        )
        .toBe(true);
      return observed;
    };
    const initial = await waitForCapability();
    const initialStatus = initial.status;
    helperPID = initial.pid;
    const permissionBlocked = initialStatus.includes(
      "needs Screen Recording permission",
    );
    let faultInjected = false;
    if (permissionBlocked) {
      expect(helperPID).toBeUndefined();
    } else {
      expect(helperPID).toBeDefined();
      await session.run("stop-real-product-transport", async () => {
        process.kill(helperPID!, "SIGSTOP");
      });
      faultInjected = true;
      await expect
        .poll(menuStatus, { timeout: 4000, interval: 30 })
        .toBe("Dock capture heartbeat unavailable");
    }
    await invoke("Hide Mosey");
    if (helperPID)
      await expect.poll(() => alive(helperPID!), { timeout: 4000 }).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(await child()).toBeUndefined();
    expect(
      await session.run("app.evaluate", () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isVisible(),
        ),
      ),
    ).toBe(false);
    await invoke("Show Mosey");
    const resumed = await waitForCapability();
    const restarted = resumed.pid;
    await session.quit();
    if (restarted)
      await expect.poll(() => alive(restarted), { timeout: 4000 }).toBe(false);
    await session.run("writeFile", () =>
      writeFile(
        path.join(session.evidence, "real-dock.json"),
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
      ),
    );
  } finally {
    try {
      // Bounded host evidence remains writable even after a session fault.
      writeFileSync(
        path.join(session.evidence, "real-dock-readiness.json"),
        JSON.stringify(readiness, null, 2),
      );
    } finally {
      await session.close();
    }
  }
});
