import { test, expect } from "vitest";
import {
  _electron as electron,
  type ElectronApplication,
  type JSHandle,
} from "playwright";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startForge } from "./support/forge";
import { nativeRuntimeFixture } from "./support/native-runtime";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

// The external OS producer is the only substitution. Public Electron window
// geometry, menu actions and owned OS processes observe the entire real app.
type LifecycleEvent = {
  event: string;
  at: number;
  monotonic: number;
  detail?: unknown;
};
type ProducerScene = {
  sourceStatus?: number;
  observation?: unknown;
  reason?: string;
  silencePID?: number;
  startupSilence?: boolean;
  sparseFreshSeconds?: number;
  shortFreshSeconds?: number;
  ignoreTerm?: boolean;
  sourceAgeSeconds?: number;
  callbackAgeSeconds?: number | null;
  idle?: boolean;
};
type Runtime = {
  publish: (value: ProducerScene) => Promise<void>;
  beginScene: () => Promise<void>;
  footY: () => Promise<number>;
  children: () => number[];
  status: () => Promise<string>;
  spawnedPIDs: () => Promise<number[]>;
  floor: number;
  observation: unknown;
  invoke: (label: string) => Promise<void>;
  app: ElectronApplication;
};
async function withRuntime(
  run: (runtime: Runtime) => Promise<void>,
  initial: ProducerScene = { observation: null },
  source: "script" | "native-status" = "script",
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-dock-recovery-"));
  const input = path.join(root, "input.json");
  const pids = path.join(root, "pids.jsonl");
  let revision = 0;
  let sceneEpoch = Date.now();
  const publish = async (value: ProducerScene) => {
    await writeFile(
      `${input}.next`,
      JSON.stringify({ ...value, revision: ++revision, sceneEpoch }),
    );
    await rename(`${input}.next`, input);
  };
  let app: ElectronApplication | undefined;
  let stopForge: (() => Promise<void>) | undefined;
  let helper = "";
  let original: Buffer | undefined;
  const ledger = async () =>
    (await readFile(pids, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  let publicEvents: JSHandle<LifecycleEvent[]> | undefined;
  await publish(initial.startupSilence ? initial : { observation: null });
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
    const scriptedProducer = `#!${process.execPath}
import fs from 'node:fs';
const start=performance.now(), birth=Date.now(); let sequence=0;
let scene={};
const record=(event,detail={})=>fs.appendFileSync(${JSON.stringify(pids)},JSON.stringify({event,pid:process.pid,ppid:process.ppid,at:Date.now(),monotonic:performance.now(),revision:scene.revision,sceneEpoch:scene.sceneEpoch,targetPID:scene.silencePID,...detail})+'\\n');
record('spawn');
const startupTarget=${JSON.stringify(path.join(root, "startup-target.json"))};
try{fs.writeFileSync(startupTarget,String(process.pid),{flag:'wx'});}catch{}
const firstStartupPID=Number(fs.readFileSync(startupTarget,'utf8'));
console.log(JSON.stringify({type:'environment',protocol:1,processID:process.pid,parentPID:process.ppid}));
let tick=0;
process.on('SIGTERM',()=>{record('SIGTERM');if(!scene.ignoreTerm)process.exit(0);});
process.on('exit',code=>record('exit',{code}));
setInterval(()=>{
  const value=JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8'));
  if(value.revision!==scene.revision){scene=value;tick=0;record('input',{value});}
  const elapsed=(performance.now()-start)/1000;
  const phaseSeconds=(Date.now()-Math.max(birth,value.sceneEpoch))/1000;
  const sparse=value.sparseFreshSeconds && phaseSeconds<value.sparseFreshSeconds;
  if(sparse && ++tick%10!==0)return;
  const shortFresh=value.shortFreshSeconds && phaseSeconds<value.shortFreshSeconds;
  const silent=!(sparse||shortFresh) && (value.reason==='callback_silence'||value.silencePID===process.pid||(value.startupSilence&&process.pid===firstStartupPID));
  const observation=silent?null:(sparse||shortFresh)?null:value.observation??null;
  const reason=silent?'callback_silence':(sparse||shortFresh)?'alpha_empty':value.reason??(observation?'current':'alpha_empty');
  const blocked=reason==='permission_lost'||reason==='permission_unavailable';
  console.log(JSON.stringify({type:'observation',elapsed,sequence:++sequence,sourceAgeSeconds:silent||blocked?null:value.sourceAgeSeconds??0,callbackAgeSeconds:silent||blocked?null:(value.callbackAgeSeconds===undefined?0:value.callbackAgeSeconds),idle:value.idle??false,reason,observation}));
  if(blocked)process.exit(2);
},100);
`;
    await writeFile(
      helper,
      source === "native-status"
        ? await nativeRuntimeFixture(root, input, pids)
        : scriptedProducer,
    );
    await chmod(helper, 0o755);
    if (initial.startupSilence) {
      // Exercise the first capture startup after the desktop preparation phase.
      // A cold app launch can legitimately change the virtual Dock workArea.
      await mkdir(path.join(root, "profile"), { recursive: true });
      await writeFile(
        path.join(root, "profile/preferences.json"),
        JSON.stringify({ version: 1, visibility: "hidden", size: "medium" }),
      );
    }
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [`--user-data-dir=${root}/profile`],
          }
        : { args: [".", `--user-data-dir=${root}/profile`] },
    );
    publicEvents = await app.evaluateHandle(
      ({ app, BrowserWindow, screen, powerMonitor }) => {
        const events: LifecycleEvent[] = [];
        const record = (event: string, detail?: unknown) =>
          events.push({
            event,
            detail,
            at: Date.now(),
            monotonic: performance.now(),
          });
        powerMonitor.on("suspend", () => record("suspend"));
        powerMonitor.on("resume", () => record("resume"));
        powerMonitor.on("lock-screen", () => record("lock-screen"));
        powerMonitor.on("unlock-screen", () => record("unlock-screen"));
        screen.on("display-metrics-changed", (_event, display, changed) =>
          record("display-metrics-changed", { display, changed }),
        );
        screen.on("display-added", (_event, display) =>
          record("display-added", display),
        );
        screen.on("display-removed", (_event, display) =>
          record("display-removed", display),
        );
        const observe = (window: Electron.BrowserWindow) => {
          window.on("show", () => record("show", window.id));
          window.on("hide", () => record("hide", window.id));
          window.on("closed", () => record("closed", window.id));
        };
        BrowserWindow.getAllWindows().forEach(observe);
        app.on("browser-window-created", (_event, window) => observe(window));
        record("attached", screen.getPrimaryDisplay());
        return events;
      },
    );
    const mainPID = app.process().pid;
    const children = () =>
      execFileSync("/bin/ps", ["-Ao", "pid=,ppid=,command="], {
        encoding: "utf8",
      })
        .split("\n")
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
        .filter(
          (parts) =>
            parts &&
            Number(parts[2]) === mainPID &&
            parts[3]!.endsWith("/dock-runtime"),
        )
        .map((parts) => Number(parts![1]));
    const pet = await app.firstWindow();
    if (initial.startupSilence) {
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isVisible(),
        ),
      ).toBe(false);
      expect(children()).toEqual([]);
      expect((await ledger()).filter((row) => row.event === "spawn")).toEqual(
        [],
      );
      let signature = "";
      let stableSince = performance.now();
      // Fixed setup budget, independent of source lifetime or recovery outcome.
      await expect
        .poll(
          async () => {
            const geometry = await app!.evaluate(({ screen }) => {
              const display = screen.getPrimaryDisplay();
              return {
                id: display.id,
                bounds: display.bounds,
                workArea: display.workArea,
                scaleFactor: display.scaleFactor,
              };
            });
            const replacements = await publicEvents!.evaluate(
              (events) =>
                events.filter((event) => {
                  if (event.event === "display-metrics-changed") {
                    const detail = event.detail;
                    return (
                      detail !== null &&
                      typeof detail === "object" &&
                      "changed" in detail &&
                      Array.isArray(detail.changed) &&
                      detail.changed.length > 0
                    );
                  }
                  return ["display-added", "display-removed"].includes(
                    event.event,
                  );
                }).length,
            );
            const next = JSON.stringify({ geometry, replacements });
            const now = performance.now();
            if (next !== signature) {
              signature = next;
              stableSince = now;
            }
            return now - stableSince >= 1000;
          },
          { timeout: 5000, interval: 100 },
        )
        .toBe(true);
      expect(children()).toEqual([]);
      expect((await ledger()).filter((row) => row.event === "spawn")).toEqual(
        [],
      );
      // Exactly one public Show; a later display interruption still fails the
      // original first-PID, five-second and uninterrupted-lifecycle assertions.
      await app.evaluate(({ Menu }) => {
        Menu.getApplicationMenu()!
          .items.find((item) => item.label === "Mosey")!
          .submenu!.items.find((item) => item.label === "Show Mosey")!
          .click();
      });
    }
    await pet.locator("canvas").waitFor();
    await pet.waitForLoadState("networkidle");
    await expect
      .poll(
        () =>
          pet.evaluate(() => {
            const canvas = document.querySelector("canvas")!;
            const pixels = canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height).data;
            return pixels.filter(
              (value, index) => index % 4 === 3 && value >= 128,
            ).length;
          }),
        { timeout: 15000 },
      )
      .toBeGreaterThan(5000);
    const id = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows()[0]!.id;
    });
    const display = await app.evaluate(({ screen }) =>
      screen.getPrimaryDisplay(),
    );
    const floor = display.workArea.y + display.workArea.height;
    await app.evaluate(
      ({ BrowserWindow, screen }, { id, floor }) => {
        const window = BrowserWindow.fromId(id)!;
        const area = screen.getPrimaryDisplay().workArea;
        const cursor = screen.getCursorScreenPoint();
        const x =
          cursor.x < area.x + area.width / 2
            ? area.x + area.width - window.getBounds().width - 40
            : area.x + 40;
        window.setPosition(x, floor - window.getBounds().height);
      },
      { id, floor },
    );
    const bounds = () =>
      app!.evaluate(
        ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getBounds(),
        id,
      );
    const footY = async () => {
      const value = await bounds();
      return value.y + value.height;
    };
    await expect.poll(children).toHaveLength(1);
    const observation = {
      orientation: "bottom",
      bounds: {
        x: display.bounds.x,
        y: floor - 75,
        width: display.bounds.width,
        height: display.bounds.y + display.bounds.height - (floor - 75),
      },
      contour: Array.from(
        { length: Math.ceil(display.bounds.width) },
        (_, i) => ({
          axis: display.bounds.x + i,
          inward: floor - 75,
        }),
      ),
      primaryDisplayID: display.id,
    };
    let epochOffset = 0;
    let epochActor: number | undefined;
    const beginScene = async () => {
      await expect
        .poll(
          async () => {
            const owned = children();
            if (owned.length !== 1) return false;
            const candidate = owned[0]!;
            const accepted = (await ledger()).some(
              (record) => record.event === "input" && record.pid === candidate,
            );
            if (!accepted) return false;
            const snapshot = await ledger();
            const confirmed = children();
            if (confirmed.length !== 1 || confirmed[0] !== candidate)
              return false;
            epochActor = candidate;
            epochOffset = snapshot.length;
            return true;
          },
          { timeout: 5000 },
        )
        .toBe(true);
      expect(children()).toEqual([epochActor]);
      sceneEpoch = Date.now();
    };
    const spawnedPIDs = async () => {
      const records = await ledger();
      return [
        ...(epochActor === undefined ? [] : [epochActor]),
        ...records
          .slice(epochOffset)
          .filter((record) => record.event === "spawn")
          .map((record) => record.pid),
      ];
    };
    if (!initial.startupSilence) {
      await beginScene();
      await publish(initial);
    }
    const status = () =>
      app!.evaluate(
        ({ Menu }) =>
          Menu.getApplicationMenu()!
            .items.find((i) => i.label === "Mosey")!
            .submenu!.items.find((i) => !i.enabled)!.label,
      );
    const invoke = (label: string) =>
      app!.evaluate(({ Menu }, label) => {
        Menu.getApplicationMenu()!
          .items.find((i) => i.label === "Mosey")!
          .submenu!.items.find((i) => i.label === label)!
          .click();
      }, label);
    if (initial.startupSilence) {
      const first = (await ledger()).find((record) => record.event === "spawn");
      expect(first).toBeDefined();
      await expect
        .poll(
          async () =>
            (await ledger()).some(
              (record) =>
                record.event === "SIGTERM" && record.pid === first.pid,
            ),
          { timeout: 11000 },
        )
        .toBe(true);
      const records = await ledger();
      const inputs = records.filter(
        (record) => record.event === "input" && record.pid === first.pid,
      );
      expect(inputs).toHaveLength(1);
      expect(inputs[0].value).toMatchObject({ startupSilence: true });
      const term = records.find(
        (record) => record.event === "SIGTERM" && record.pid === first.pid,
      );
      expect(term.monotonic - inputs[0].monotonic).toBeGreaterThanOrEqual(5000);
      const lifecycle = await publicEvents.evaluate((events) => events);
      expect(lifecycle[0]!.at).toBeLessThanOrEqual(first.at);
      const interruptions = lifecycle.filter((event) => {
        if (event.at < first.at || event.at > term.at) return false;
        if (event.event === "display-metrics-changed") {
          const detail = event.detail;
          return !(
            detail &&
            typeof detail === "object" &&
            "changed" in detail &&
            Array.isArray(detail.changed) &&
            detail.changed.length === 0
          );
        }
        return [
          "display-added",
          "display-removed",
          "hide",
          "suspend",
          "resume",
          "lock-screen",
          "unlock-screen",
        ].includes(event.event);
      });
      expect(
        interruptions,
        "startup silence must reach five seconds without a replacing lifecycle event",
      ).toEqual([]);
    }
    await run({
      publish,
      beginScene,
      footY,
      children,
      status,
      spawnedPIDs,
      floor,
      observation,
      invoke,
      app,
    });
    await mkdir("test-results", { recursive: true });
    const name = expect
      .getState()
      .currentTestName!.replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase();
    await writeFile(
      `test-results/${packaged ? "packaged" : "development"}-${name}.json`,
      JSON.stringify(
        {
          evidence:
            "Synthetic OS producer; real Electron app, owned OS processes and public geometry. No physical Dock or SCK root-cause claim.",
          spawnedPIDs: await spawnedPIDs(),
          scenarioBoundary: {
            sceneEpoch,
            actor: epochActor,
            ledgerOffset: epochOffset,
          },
          fullProducerLedger: await ledger(),
          publicLifecycle: await publicEvents.evaluate((events) => events),
          remainingOwnedChildren: children(),
          finalBounds: await bounds(),
          nativeFixtureReceipt:
            source === "native-status"
              ? JSON.parse(
                  await readFile(
                    path.join(root, "native-source-fixture-receipt.json"),
                    "utf8",
                  ),
                )
              : undefined,
          menu: await app.evaluate(({ Menu }) =>
            Menu.getApplicationMenu()!
              .items.find((i) => i.label === "Mosey")!
              .submenu!.items.map((i) => i.label),
          ),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await mkdir("test-results", { recursive: true });
    const name = expect
      .getState()
      .currentTestName!.replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase();
    await writeFile(
      `test-results/failure-${packaged ? "packaged" : "development"}-${name}.json`,
      JSON.stringify(
        {
          producerLedger: await ledger(),
          nativeFixtureReceipt:
            source === "native-status"
              ? await readFile(
                  path.join(root, "native-source-fixture-receipt.json"),
                  "utf8",
                ).catch(() => undefined)
              : undefined,
          input: await readFile(input, "utf8"),
          publicLifecycle: await publicEvents
            ?.evaluate((events) => events)
            .catch(() => undefined),
          publicState: await app
            ?.evaluate(({ Menu, BrowserWindow, screen }) => ({
              menu: Menu.getApplicationMenu()?.items.map((item) => ({
                label: item.label,
                submenu: item.submenu?.items.map((i) => i.label),
              })),
              windows: BrowserWindow.getAllWindows().map((window) => ({
                id: window.id,
                visible: window.isVisible(),
                bounds: window.getBounds(),
              })),
              display: screen.getPrimaryDisplay(),
            }))
            .catch(() => undefined),
        },
        null,
        2,
      ),
    );
    await app
      ?.windows()[0]
      ?.screenshot({
        path: `test-results/failure-${packaged ? "packaged" : "development"}-dock-recovery.png`,
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
}

test("Explicit source suspension waits on one capture and resumes without Retry", async () => {
  await withRuntime(
    async ({ publish, observation, children, footY, floor, status }) => {
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      const sourcePID = children()[0]!;
      // A real public native status attachment enters the unchanged product
      // Receiver. No synthetic protocol reason bypasses its normalization.
      await publish({ sourceStatus: 3 });
      await expect.poll(footY, { timeout: 3000 }).toBe(floor);
      const until = performance.now() + 9000;
      while (performance.now() < until) {
        expect(children()).toEqual([sourcePID]);
        expect(await footY()).toBe(floor);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await expect
        .poll(status)
        .toBe("Dock source suspended; waiting for updates");
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      expect(children()).toEqual([sourcePID]);
    },
    { observation: null },
    "native-status",
  );
});

test("Unstable bottom contact stays grounded while stable overlap supports climbing", async () => {
  await withRuntime(
    async ({ app, publish, observation, footY, floor, children }) => {
      const originalPID = children()[0]!;
      const origin = await app.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        const area = screen.getPrimaryDisplay().workArea;
        const bounds = window.getBounds();
        window.setPosition(
          area.x + Math.round((area.width - bounds.width) / 2),
          area.y + area.height - bounds.height,
        );
        return window.getBounds();
      });
      expect(origin.width).toBe(240);
      const display = await app.evaluate(({ screen }) =>
        screen.getPrimaryDisplay(),
      );
      const bounds = () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.getBounds(),
        );
      const bottom = (start: number) => ({
        orientation: "bottom",
        bounds: {
          x: start,
          y: floor - 75,
          width: display.bounds.x + display.bounds.width - start,
          height: display.bounds.y + display.bounds.height - (floor - 75),
        },
        contour: Array.from(
          {
            length: Math.ceil(display.bounds.x + display.bounds.width - start),
          },
          (_, index) => ({ axis: start + index, inward: floor - 75 }),
        ),
        primaryDisplayID: display.id,
      });
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      await publish({ observation: null });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor);
      // Same relative contour as the observed x615/start826 oscillation.
      // This overlaps the resting silhouette but misses stable bottom contact.
      await publish({ observation: bottom(origin.x + 211) });
      const until = performance.now() + 6500;
      while (performance.now() < until) {
        expect(await footY()).toBe(floor);
        expect((await bounds()).x).toBe(origin.x);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // The observed x615/start814 control is narrow but stably supported.
      await publish({ observation: bottom(origin.x + 199) });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(await footY()).toBe(floor - 75);
      await publish({ observation: null });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor);
      await publish({ observation: bottom(origin.x + 260) });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await footY()).toBe(floor);
      for (const orientation of ["left", "right"] as const) {
        const before = await bounds();
        const inward = before.x + (orientation === "left" ? 100 : 140);
        await publish({
          observation: {
            orientation,
            bounds: {
              x: orientation === "left" ? display.bounds.x : inward,
              y: display.bounds.y,
              width:
                orientation === "left"
                  ? inward - display.bounds.x
                  : display.bounds.x + display.bounds.width - inward,
              height: display.bounds.height,
            },
            contour: Array.from(
              { length: Math.ceil(display.bounds.height) },
              (_, index) => ({ axis: display.bounds.y + index, inward }),
            ),
            primaryDisplayID: display.id,
          },
        });
        await expect
          .poll(async () =>
            orientation === "left"
              ? (await bounds()).x > before.x
              : (await bounds()).x < before.x,
          )
          .toBe(true);
        expect(await footY()).toBe(floor);
        await publish({ observation: null });
      }
      expect(children()).toEqual([originalPID]);
    },
  );
});

test("Dock capture rebuilds a continuously silent stream and restores support without manual Retry", async () => {
  await withRuntime(
    async ({
      publish,
      beginScene,
      footY,
      children,
      spawnedPIDs,
      floor,
      observation,
      app,
    }) => {
      const setupPID = children()[0]!;
      await app.evaluate(({ screen }) =>
        screen.emit("display-metrics-changed", {}, screen.getPrimaryDisplay(), [
          "workArea",
        ]),
      );
      await expect
        .poll(() => {
          const owned = children();
          return owned.length === 1 && owned[0] !== setupPID;
        })
        .toBe(true);
      await beginScene();
      const firstPID = children()[0]!;
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      await publish({ observation, silencePID: firstPID });
      await expect.poll(footY, { timeout: 3000 }).toBe(floor);
      await expect
        .poll(
          () => {
            const owned = children();
            return owned.length === 1 && owned[0] !== firstPID;
          },
          { timeout: 11000, interval: 100 },
        )
        .toBe(true);
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      expect(await spawnedPIDs()).toHaveLength(2);
    },
  );
});

test("Empty display-metric notifications preserve a healthy owned capture and support", async () => {
  await withRuntime(
    async ({
      publish,
      observation,
      children,
      spawnedPIDs,
      footY,
      floor,
      app,
    }) => {
      const healthyPID = children()[0]!;
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      await app.evaluate(async ({ screen }) => {
        const display = screen.getPrimaryDisplay();
        for (let index = 0; index < 5; index++) {
          screen.emit("display-metrics-changed", {}, display, []);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(children()).toEqual([healthyPID]);
      expect(await spawnedPIDs()).toHaveLength(1);
      expect(await footY()).toBe(floor - 75);
    },
  );
});

test("Sparse fresh reports do not replenish the bounded silent-stream recovery budget", async () => {
  await withRuntime(
    async ({ children, spawnedPIDs, invoke, status }) => {
      // Each owned producer sends seven seconds of isolated fresh records a second
      // apart, then timely silence JSON. Their uncovered gaps exceed frame freshness.
      await expect
        .poll(status, { timeout: 55000, interval: 150 })
        .toBe("Dock capture unavailable; Retry Dock interaction");
      await expect.poll(children, { timeout: 3000 }).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(4);
      await invoke("Hide Mosey");
      await invoke("Show Mosey");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(children()).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(4);
    },
    { reason: "callback_silence", sparseFreshSeconds: 7.1 },
  );
});

test("Brief fresh callbacks cannot reset exhaustion, while explicit Retry works without starting hidden capture", async () => {
  await withRuntime(
    async ({
      children,
      spawnedPIDs,
      invoke,
      publish,
      observation,
      footY,
      floor,
      app,
      status,
    }) => {
      await expect
        .poll(status, { timeout: 30000, interval: 100 })
        .toBe("Dock capture unavailable; Retry Dock interaction");
      await expect.poll(children, { timeout: 3000 }).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(4);
      await invoke("Hide Mosey");
      await invoke("Show Mosey");
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(children()).toEqual([]);
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit("suspend"));
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(children()).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(4);
      await invoke("Hide Mosey");
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.isVisible(),
          ),
        )
        .toBe(false);
      await expect.poll(status).toBe("Stopped");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await publish({ observation });
      await invoke("Retry Dock interaction");
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(children()).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(4);
      await invoke("Show Mosey");
      await expect.poll(children, { timeout: 4000 }).toHaveLength(1);
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      expect(await spawnedPIDs()).toHaveLength(5);
    },
    { reason: "callback_silence", shortFreshSeconds: 0.3 },
  );
});

test("Capture startup silence recovers while healthy idle, empty frames, brief silence and permission refusal keep their boundaries", async () => {
  await withRuntime(
    async ({
      children,
      spawnedPIDs,
      publish,
      observation,
      footY,
      floor,
      invoke,
      app,
    }) => {
      await expect
        .poll(async () => (await spawnedPIDs()).length)
        .toBeGreaterThan(0);
      const initialPID = (await spawnedPIDs())[0]!;
      expect(await footY()).toBe(floor);
      await expect
        .poll(
          () => {
            const owned = children();
            return owned.length === 1 && owned[0] !== initialPID;
          },
          { timeout: 11000 },
        )
        .toBe(true);
      const healthyPID = children()[0]!;
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      await publish({
        observation,
        idle: true,
        reason: "idle_current",
        sourceAgeSeconds: 60,
      });
      await new Promise((resolve) => setTimeout(resolve, 5500));
      expect(children()).toEqual([healthyPID]);
      expect(await footY()).toBe(floor - 75);
      await publish({ observation: null, reason: "alpha_empty" });
      await expect.poll(footY).toBe(floor);
      await new Promise((resolve) => setTimeout(resolve, 5500));
      expect(children()).toEqual([healthyPID]);
      await publish({ reason: "callback_silence" });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      expect(children()).toEqual([healthyPID]);
      await publish({ reason: "permission_lost" });
      await expect.poll(children, { timeout: 3000 }).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(children()).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(2);
      await expect.poll(footY).toBe(floor);
      await publish({ observation });
      await invoke("Retry Dock interaction");
      await expect.poll(children).toHaveLength(1);
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      await publish({ reason: "permission_unavailable" });
      await expect.poll(children, { timeout: 3000 }).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(children()).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(3);
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit("suspend"));
      await publish({ observation });
      await invoke("Retry Dock interaction");
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(children()).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(3);
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
      await expect.poll(children).toHaveLength(1);
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      expect(await spawnedPIDs()).toHaveLength(4);
    },
    { startupSilence: true },
  );
});

test("Hidden, suspended and diagnostic ownership cancel queued rebuilds without replenishing the budget", async () => {
  await withRuntime(
    async ({ publish, children, spawnedPIDs, invoke, app, status }) => {
      const diagnostic = (label: string) =>
        app.evaluate(({ Menu }, label) => {
          Menu.getApplicationMenu()!
            .items.find((i) => i.label === "Dock validation")!
            .submenu!.items.find((i) => i.label === label)!
            .click();
        }, label);
      const pauses = ["hidden", "suspended", "diagnostic"] as const;
      await publish({ reason: "callback_silence", ignoreTerm: true });
      for (const [index, pause] of pauses.entries()) {
        // SIGTERM is ignored only by this owned producer, exposing the real
        // application's 1.5s kill fallback and the pending restart race.
        await expect
          .poll(status, { timeout: 8000, interval: 25 })
          .toBe("Dock capture callbacks unavailable; restarting");
        if (pause === "hidden") await invoke("Hide Mosey");
        else if (pause === "suspended")
          await app.evaluate(({ powerMonitor }) =>
            powerMonitor.emit("suspend"),
          );
        else {
          const opened = app.waitForEvent("window");
          await diagnostic("Start Dock validation (120 seconds)");
          const panel = await opened;
          await panel
            .getByRole("heading", { name: "Dock validation" })
            .waitFor();
        }
        await expect.poll(children, { timeout: 4000 }).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(children()).toEqual([]);
        expect(await spawnedPIDs()).toHaveLength(index + 1);
        if (pause === "hidden") await invoke("Show Mosey");
        else if (pause === "suspended")
          await app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
        else await diagnostic("Stop Dock validation");
        await expect.poll(children, { timeout: 4000 }).toHaveLength(1);
      }
      // All three attempted recoveries were cancelled by ownership changes.
      // Those ordinary stop/start boundaries must not create another allowance.
      await expect
        .poll(status, { timeout: 8000, interval: 100 })
        .toBe("Dock capture unavailable; Retry Dock interaction");
      await expect.poll(children, { timeout: 4000 }).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(4);
    },
  );
});

test("Sustained fresh callbacks replenish recovery, but non-silent reports with no callback age do not", async () => {
  await withRuntime(
    async ({ publish, children, spawnedPIDs, status }) => {
      await expect
        .poll(async () => (await spawnedPIDs()).length, { timeout: 25000 })
        .toBe(4);
      await expect.poll(children).toHaveLength(1);
      const fourthPID = children()[0]!;
      await publish({ reason: "alpha_empty" });
      await new Promise((resolve) => setTimeout(resolve, 5600));
      expect(children()).toEqual([fourthPID]);
      // The three old attempts have now been replenished by genuinely fresh
      // callbacks, despite having no visible alpha geometry to stand on.
      await publish({ reason: "callback_silence" });
      await expect
        .poll(async () => (await spawnedPIDs()).length, { timeout: 8000 })
        .toBe(5);
      await expect.poll(children).toHaveLength(1);
      const fifthPID = children()[0]!;
      // Merely changing the reason away from silence does not prove callbacks.
      await publish({ reason: "alpha_empty", callbackAgeSeconds: null });
      await new Promise((resolve) => setTimeout(resolve, 5600));
      expect(children()).toEqual([fifthPID]);
      await publish({ reason: "callback_silence" });
      await expect
        .poll(async () => (await spawnedPIDs()).length, { timeout: 8000 })
        .toBe(6);
      await expect
        .poll(async () => (await spawnedPIDs()).length, { timeout: 8000 })
        .toBe(7);
      await expect
        .poll(status, { timeout: 8000 })
        .toBe("Dock capture unavailable; Retry Dock interaction");
      await expect.poll(children, { timeout: 3000 }).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(7);
    },
    { reason: "callback_silence", shortFreshSeconds: 0.3 },
  );
});
