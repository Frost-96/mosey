import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
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

const packaged = process.env.MOSEY_TEST_MODE === "packaged";

// The external OS producer is the only substitution. Public Electron window
// geometry, menu actions and owned OS processes observe the entire real app.
type Runtime = {
  publish: (value: unknown) => Promise<void>;
  footY: () => Promise<number>;
  children: () => number[];
  spawnedPIDs: () => Promise<number[]>;
  floor: number;
  observation: unknown;
  invoke: (label: string) => Promise<void>;
  app: ElectronApplication;
};
async function withRuntime(
  run: (runtime: Runtime) => Promise<void>,
  initial: unknown = { observation: null },
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mosey-dock-recovery-"));
  const input = path.join(root, "input.json");
  const pids = path.join(root, "pids.jsonl");
  const publish = async (value: unknown) => {
    await writeFile(`${input}.next`, JSON.stringify(value));
    await rename(`${input}.next`, input);
  };
  let app: ElectronApplication | undefined;
  let stopForge: (() => Promise<void>) | undefined;
  let helper = "";
  let original: Buffer | undefined;
  await publish(initial);
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
      `#!${process.execPath}
import fs from 'node:fs';
const start=performance.now(); let sequence=0;
fs.appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');
const ordinal=fs.readFileSync(${JSON.stringify(pids)},'utf8').trim().split('\\n').length;
console.log(JSON.stringify({type:'environment',protocol:1,processID:process.pid,parentPID:process.ppid}));
let tick=0, ignoresTerm=false;
setInterval(()=>{
  const value=JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8'));
  if(value.ignoreTerm && !ignoresTerm){process.on('SIGTERM',()=>{});ignoresTerm=true;}
  const elapsed=(performance.now()-start)/1000;
  const sparse=value.sparseFreshSeconds && elapsed<value.sparseFreshSeconds;
  if(sparse && ++tick%10!==0)return;
  const shortFresh=value.shortFreshSeconds && elapsed<value.shortFreshSeconds;
  const silent=!(sparse||shortFresh) && (value.reason==='callback_silence'||(value.silenceFirstChild&&ordinal===1));
  const observation=silent?null:(sparse||shortFresh)?null:value.observation??null;
  const reason=silent?'callback_silence':(sparse||shortFresh)?'alpha_empty':value.reason??(observation?'current':'alpha_empty');
  const blocked=reason==='permission_lost'||reason==='permission_unavailable';
  console.log(JSON.stringify({type:'observation',elapsed,sequence:++sequence,sourceAgeSeconds:silent||blocked?null:value.sourceAgeSeconds??0,callbackAgeSeconds:silent||blocked?null:(value.callbackAgeSeconds===undefined?0:value.callbackAgeSeconds),idle:value.idle??false,reason,observation}));
  if(blocked)process.exit(2);
},100);
`,
    );
    await chmod(helper, 0o755);
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
    const spawnedPIDs = async () =>
      (await readFile(pids, "utf8")).trim().split("\n").map(Number);
    const invoke = (label: string) =>
      app!.evaluate(({ Menu }, label) => {
        Menu.getApplicationMenu()!
          .items.find((i) => i.label === "Mosey")!
          .submenu!.items.find((i) => i.label === label)!
          .click();
      }, label);
    await run({
      publish,
      footY,
      children,
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
          remainingOwnedChildren: children(),
          finalBounds: await bounds(),
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

test("Dock capture rebuilds a continuously silent stream and restores support without manual Retry", async () => {
  await withRuntime(
    async ({ publish, footY, children, spawnedPIDs, floor, observation }) => {
      const firstPID = children()[0]!;
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      await publish({ observation, silenceFirstChild: true });
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

test("Sparse fresh reports do not replenish the bounded silent-stream recovery budget", async () => {
  await withRuntime(
    async ({ children, spawnedPIDs, invoke, app }) => {
      const status = () =>
        app.evaluate(
          ({ Menu }) =>
            Menu.getApplicationMenu()!
              .items.find((i) => i.label === "Mosey")!
              .submenu!.items.find((i) => !i.enabled)!.label,
        );
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
    }) => {
      const status = () =>
        app.evaluate(
          ({ Menu }) =>
            Menu.getApplicationMenu()!
              .items.find((i) => i.label === "Mosey")!
              .submenu!.items.find((i) => !i.enabled)!.label,
        );
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

test("Startup silence recovers while healthy idle, empty frames, brief silence and permission refusal keep their boundaries", async () => {
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
      const initialPID = children()[0]!;
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
    { silenceFirstChild: true },
  );
});

test("Hidden, suspended and diagnostic ownership cancel queued rebuilds without replenishing the budget", async () => {
  await withRuntime(async ({ publish, children, spawnedPIDs, invoke, app }) => {
    const status = () =>
      app.evaluate(
        ({ Menu }) =>
          Menu.getApplicationMenu()!
            .items.find((i) => i.label === "Mosey")!
            .submenu!.items.find((i) => !i.enabled)!.label,
      );
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
        await app.evaluate(({ powerMonitor }) => powerMonitor.emit("suspend"));
      else {
        const opened = app.waitForEvent("window");
        await diagnostic("Start Dock validation (120 seconds)");
        const panel = await opened;
        await panel.getByRole("heading", { name: "Dock validation" }).waitFor();
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
  });
});

test("Sustained fresh callbacks replenish recovery, but non-silent reports with no callback age do not", async () => {
  await withRuntime(
    async ({ publish, children, spawnedPIDs, app }) => {
      const status = () =>
        app.evaluate(
          ({ Menu }) =>
            Menu.getApplicationMenu()!
              .items.find((i) => i.label === "Mosey")!
              .submenu!.items.find((i) => !i.enabled)!.label,
        );
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
