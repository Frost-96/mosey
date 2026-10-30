import { test, expect } from "vitest";
import type { ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPetTestSession,
  type SessionOperation,
} from "./support/pet-session";
import { distanceFromGround } from "./support/ground";
import { nativeRuntimeFixture } from "./support/native-runtime";

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
  groundDistance: () => Promise<number>;
  children: () => Promise<number[]>;
  status: () => Promise<string>;
  spawnedPIDs: () => Promise<number[]>;
  floor: number;
  observation: unknown;
  invoke: (label: string) => Promise<void>;
  app: ElectronApplication;
  session: Awaited<ReturnType<typeof createPetTestSession>>;
};
async function withRuntime(
  scenario: (runtime: Runtime) => Promise<void>,
  initial: ProducerScene = { observation: null },
  source: "script" | "native-status" = "script",
) {
  let input = "";
  let pids = "";
  let inputs = "";
  let revision = 0;
  let sceneEpoch = Date.now();
  const publishWith = async (value: ProducerScene, run: SessionOperation) => {
    const frame = { ...value, revision: ++revision, sceneEpoch };
    const label = `dock-input-${revision}:${value.reason ?? value.sourceStatus ?? "geometry"}`;
    await run(`${label}:write`, () =>
      writeFile(`${input}.next`, JSON.stringify(frame)),
    );
    // Retain the exact proposed input before publication. The producer ledger
    // separately proves which revision each real child actually accepted.
    await run(`${label}:evidence`, () =>
      appendFile(inputs, JSON.stringify({ input, value: frame }) + "\n"),
    );
    await run(`${label}:publish`, () => rename(`${input}.next`, input));
  };
  const session = await createPetTestSession({
    // Existing contour coordinates use a 240DIP pet.
    preferences: {
      version: 3,
      character: "corgi",
      // Install the exit observer before any capture can start. Launch-time
      // display changes may retire a producer before session.launch returns.
      visibility: "hidden",
      size: 240,
    },
    dock: {
      name: `recovery-${source}`,
      async prepare({ root, evidence, run, signal }) {
        input = path.join(root, "input.json");
        pids = path.join(evidence, "producer-events.jsonl");
        inputs = path.join(evidence, "producer-inputs.jsonl");
        await run("initialize-producer-ledger", () => writeFile(pids, ""));
        await publishWith(
          initial.startupSilence ? initial : { observation: null },
          run,
        );
        if (source === "native-status") {
          const binary = await nativeRuntimeFixture(root, input, pids, {
            run,
            signal,
          });
          const receipt = await run("read-native-fixture-receipt", () =>
            readFile(path.join(root, "native-source-fixture-receipt.json")),
          );
          await run("retain-native-fixture-receipt", () =>
            writeFile(
              path.join(evidence, "native-source-fixture-receipt.json"),
              receipt,
            ),
          );
          return binary;
        }
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
        return scriptedProducer;
      },
    },
  });
  const publish = (value: ProducerScene) => publishWith(value, session.run);
  const ledger = async () =>
    (await session.run("read-producer-ledger", () => readFile(pids, "utf8")))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  let failure: unknown;
  try {
    const { app, pet } = await session.launch();
    const publicEvents = await session.run("app.evaluateHandle", () =>
      app.evaluateHandle(
        ({ app, BrowserWindow, screen, powerMonitor }, output) => {
          let bytes = 0;
          const events: LifecycleEvent[] = [];
          const record = (event: string, detail?: unknown) => {
            const row = {
              event,
              detail,
              at: Date.now(),
              // Avoid the lazily initialized global performance getter while
              // Electron's Node bootstrap may still be completing. This ledger's
              // monotonic clock is hrtime milliseconds; producer clocks are separate.
              monotonic: Number(process.hrtime.bigint()) / 1_000_000,
            };
            events.push(row);
            const line = JSON.stringify(row) + "\n";
            if (bytes + Buffer.byteLength(line) <= 256 * 1024) {
              process.getBuiltinModule("node:fs").appendFileSync(output, line);
              bytes += Buffer.byteLength(line);
            }
          };
          // Observe public child exit events without changing their dispatch,
          // signals or timing. SIGKILL cannot write a producer exit ledger row.
          const { ChildProcess } =
            process.getBuiltinModule("node:child_process");
          const originalEmit = ChildProcess.prototype.emit;
          ChildProcess.prototype.emit = function (
            this: import("node:child_process").ChildProcess,
            event: string | symbol,
            ...args: unknown[]
          ) {
            if (event === "exit" || event === "close")
              record(`child-${event}`, {
                pid: this.pid,
                code: args[0],
                signal: args[1],
              });
            return Reflect.apply(originalEmit, this, [event, ...args]);
          };
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
        path.join(session.evidence, "public-lifecycle.jsonl"),
      ),
    );
    const mainPID = app.process().pid;
    const observerStarted = await session.run("observer-started", () =>
      publicEvents.evaluate((events) => events[0]!.at),
    );
    expect(
      (await ledger())
        .filter((row) => row.event === "spawn")
        .every((row) => row.at >= observerStarted),
      "exit observation begins before every owned producer",
    ).toBe(true);
    const children = () =>
      session.run("owned-producer-processes", async () =>
        execFileSync("/bin/ps", ["-Ao", "pid=,ppid=,command="], {
          encoding: "utf8",
          timeout: 5000,
        })
          .split("\n")
          .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
          .filter(
            (parts) =>
              parts &&
              Number(parts[2]) === mainPID &&
              parts[3]!.endsWith("/dock-runtime"),
          )
          .map((parts) => Number(parts![1])),
      );
    {
      expect(
        await session.run("observe-pet-visibility", () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.isVisible(),
          ),
        ),
      ).toBe(false);
      expect(await children()).toEqual([]);
      expect((await ledger()).filter((row) => row.event === "spawn")).toEqual(
        [],
      );
      let signature = "";
      let stableSince = performance.now();
      // Fixed setup budget, independent of source lifetime or recovery outcome.
      await expect
        .poll(
          async () => {
            const geometry = await session.run("observe-primary-display", () =>
              app.evaluate(({ screen }) => {
                const display = screen.getPrimaryDisplay();
                return {
                  id: display.id,
                  bounds: display.bounds,
                  workArea: display.workArea,
                  scaleFactor: display.scaleFactor,
                };
              }),
            );
            const replacements = await session.run(
              "publicEvents.evaluate",
              () =>
                publicEvents.evaluate(
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
                ),
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
      expect(await children()).toEqual([]);
      expect((await ledger()).filter((row) => row.event === "spawn")).toEqual(
        [],
      );
      // Exactly one public Show; a later display interruption still fails the
      // original first-PID, five-second and uninterrupted-lifecycle assertions.
      await session.run("show-startup-pet", () =>
        app.evaluate(({ Menu }) => {
          Menu.getApplicationMenu()!
            .items.find((item) => item.label === "Mosey")!
            .submenu!.items.find((item) => item.label === "Show Mosey")!
            .click();
        }),
      );
    }
    await session.run("pet.waitFor", () => pet.locator("canvas").waitFor());
    await session.run("pet.waitForLoadState", () =>
      pet.waitForLoadState("networkidle"),
    );
    await expect
      .poll(
        () =>
          session.run("pet.evaluate", () =>
            pet.evaluate(() => {
              const canvas = document.querySelector("canvas")!;
              const pixels = canvas
                .getContext("2d")!
                .getImageData(0, 0, canvas.width, canvas.height).data;
              return pixels.filter(
                (value, index) => index % 4 === 3 && value >= 128,
              ).length;
            }),
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(5000);
    const id = await session.run("observe-pet-window-id", () =>
      app.evaluate(({ BrowserWindow }) => {
        return BrowserWindow.getAllWindows()[0]!.id;
      }),
    );
    const display = await session.run("observe-primary-display", () =>
      app.evaluate(({ screen }) => screen.getPrimaryDisplay()),
    );
    const floor = display.workArea.y + display.workArea.height;
    await session.run("place-pet-at-ground", () =>
      app.evaluate(
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
      ),
    );
    const observed = new Map<string, string>();
    const retainObservation = async (kind: string, value: unknown) => {
      const serialized = JSON.stringify(value);
      if (observed.get(kind) === serialized) return;
      observed.set(kind, serialized);
      await session.run(`retain-${kind}`, () =>
        appendFile(
          path.join(session.evidence, "observations.jsonl"),
          JSON.stringify({
            kind,
            value,
            revision,
            sceneEpoch,
            at: Date.now(),
          }) + "\n",
        ),
      );
    };
    const bounds = async () => {
      const value = await session.run("observe-pet-bounds", () =>
        app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getBounds(),
          id,
        ),
      );
      await retainObservation("pet-bounds", value);
      return value;
    };
    const groundDistance = async () => {
      const value = await session.run("observe-ground-distance", () =>
        distanceFromGround(app),
      );
      await retainObservation("ground-distance", value);
      return value;
    };
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
            const owned = await children();
            if (owned.length !== 1) return false;
            const candidate = owned[0]!;
            const accepted = (await ledger()).some(
              (record) => record.event === "input" && record.pid === candidate,
            );
            if (!accepted) return false;
            const snapshot = await ledger();
            const confirmed = await children();
            if (confirmed.length !== 1 || confirmed[0] !== candidate)
              return false;
            epochActor = candidate;
            epochOffset = snapshot.length;
            return true;
          },
          { timeout: 5000 },
        )
        .toBe(true);
      expect(await children()).toEqual([epochActor]);
      sceneEpoch = Date.now();
      await session.run("retain-scene-boundary", () =>
        appendFile(
          path.join(session.evidence, "scene-boundaries.jsonl"),
          JSON.stringify({
            sceneEpoch,
            actor: epochActor,
            ledgerOffset: epochOffset,
          }) + "\n",
        ),
      );
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
    const status = async () => {
      const value = await session.run("observe-dock-status", () =>
        app.evaluate(
          ({ Menu }) =>
            Menu.getApplicationMenu()!.getMenuItemById("dock-runtime-status")!
              .label,
        ),
      );
      await retainObservation("dock-status", value);
      return value;
    };
    const invoke = (label: string) =>
      session.run(`menu:${label}`, () =>
        app.evaluate(({ Menu }, label) => {
          Menu.getApplicationMenu()!
            .items.find((i) => i.label === "Mosey")!
            .submenu!.items.find((i) => i.label === label)!
            .click();
        }, label),
      );
    if (initial.startupSilence) {
      // A spawned OS process can be visible to ps before its JS entry writes
      // the first ledger record. Wait for that observable fixture boundary.
      await expect
        .poll(
          async () =>
            (await ledger()).some((record) => record.event === "spawn"),
          { timeout: 5000 },
        )
        .toBe(true);
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
      const lifecycle = await session.run("publicEvents.evaluate", () =>
        publicEvents.evaluate((events) => events),
      );
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
    await scenario({
      publish,
      beginScene,
      footY,
      groundDistance,
      children,
      status,
      spawnedPIDs,
      floor,
      observation,
      invoke,
      app,
      session,
    });
    const summary = {
      evidence:
        "Synthetic OS producer; real Electron app, owned OS processes and public geometry. No physical Dock or SCK root-cause claim.",
      spawnedPIDs: await spawnedPIDs(),
      scenarioBoundary: {
        sceneEpoch,
        actor: epochActor,
        ledgerOffset: epochOffset,
      },
      fullProducerLedger: await ledger(),
      publicLifecycle: await session.run("final-public-lifecycle", () =>
        publicEvents.evaluate((events) => events),
      ),
      remainingOwnedChildren: await children(),
      finalBounds: await bounds(),
      menu: await session.run("final-menu", () =>
        app.evaluate(({ Menu }) =>
          Menu.getApplicationMenu()!
            .items.find((i) => i.label === "Mosey")!
            .submenu!.items.map((i) => i.label),
        ),
      ),
    };
    await session.run("retain-recovery-outcome", () =>
      writeFile(
        path.join(session.evidence, "dock-recovery.json"),
        JSON.stringify(summary, null, 2),
      ),
    );
    await session.quit();
    const rows = await ledger();
    const exits = (
      await session.run("producer-exit-events", () =>
        readFile(path.join(session.evidence, "public-lifecycle.jsonl"), "utf8"),
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const owned = rows
      .filter((row) => row.event === "spawn")
      .map((row) => row.pid);
    for (const pid of owned) {
      expect(
        rows.some((row) => row.pid === pid && row.event === "exit") ||
          exits.some(
            (row) =>
              row.event === "child-exit" &&
              row.detail.pid === pid &&
              (row.detail.code !== null || row.detail.signal !== null),
          ),
        `producer ${pid} has an actual exit code or signal`,
      ).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    }
    await session.run("retain-producer-exits", () =>
      writeFile(
        path.join(session.evidence, "producer-cleanup.json"),
        JSON.stringify({ pids: owned, allExited: true }),
      ),
    );
  } catch (error) {
    failure = error;
    // No post-failure operation can resume the scenario. Inputs, complete PID
    // history and bounded public lifecycle/exit events are already durable;
    // the session and Vitest retain the failing operation/assertion.
  }
  const cleanup = await session.close().then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  if (failure !== undefined && cleanup)
    throw new AggregateError(
      [failure, cleanup.error],
      "Recovery scenario and cleanup failed",
      { cause: failure },
    );
  if (failure !== undefined) throw failure;
  if (cleanup) throw cleanup.error;
}

test("A failed recovery scene releases its producer and the next scene owns fresh application state", async () => {
  const evidence: string[] = [];
  let failedApp = "";
  let failedPID = 0;
  let failedProducer = 0;
  let latePublish: Runtime["publish"] | undefined;
  let lateInvoke: Runtime["invoke"] | undefined;
  await expect(
    withRuntime(async ({ app, publish, children, status, session, invoke }) => {
      evidence.push(session.evidence);
      latePublish = publish;
      lateInvoke = invoke;
      failedApp = await session.run("observe-application-path", () =>
        app.evaluate(({ app }) => app.getAppPath()),
      );
      failedPID = app.process().pid!;
      failedProducer = (await children())[0]!;
      await publish({ reason: "callback_silence", ignoreTerm: true });
      await expect
        .poll(status, { timeout: 8000, interval: 25 })
        .toBe("Dock capture callbacks unavailable; restarting");
      await session.run(
        "deliberate recovery scenario failure",
        () => new Promise<never>(() => {}),
        { timeout: 100 },
      );
    }),
  ).rejects.toThrow("deliberate recovery scenario failure");
  await expect(latePublish!({ reason: "permission_lost" })).rejects.toThrow(
    /closed or cancelled/,
  );
  await expect(lateInvoke!("Retry Dock interaction")).rejects.toThrow(
    /closed or cancelled/,
  );

  let nextApp = "";
  await withRuntime(
    async ({ app, children, status, groundDistance, session }) => {
      evidence.push(session.evidence);
      nextApp = await session.run("observe-application-path", () =>
        app.evaluate(({ app }) => app.getAppPath()),
      );
      expect(app.process().pid).not.toBe(failedPID);
      expect(await children()).not.toContain(failedProducer);
      await expect
        .poll(status)
        .toBe("Dock interaction waiting for visible Dock");
      expect(await groundDistance()).toBe(0);
    },
  );
  expect(nextApp, "every recovery scene owns an independent app copy").not.toBe(
    failedApp,
  );
  for (const pid of [failedPID, failedProducer])
    expect(() => process.kill(pid, 0)).toThrow();
  // These are durable receipts read after cleanup, with a separate evidence
  // deadline. No cancelled session is reentered to acquire more app state.
  const receipts = [];
  const inputs = [];
  for (const directory of evidence) {
    receipts.push(
      JSON.parse(
        await readFile(path.join(directory, "native-isolation.json"), {
          encoding: "utf8",
          signal: AbortSignal.timeout(5000),
        }),
      ),
    );
    inputs.push(
      (
        await readFile(path.join(directory, "producer-inputs.jsonl"), {
          encoding: "utf8",
          signal: AbortSignal.timeout(5000),
        })
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  }
  for (const receipt of receipts) {
    expect(receipt.after).toEqual(receipt.before);
    expect(receipt.diagnosticAfter).toEqual(receipt.diagnosticBefore);
  }
  expect(inputs[0]!.at(-1).value).toMatchObject({
    reason: "callback_silence",
    ignoreTerm: true,
  });
  expect(inputs[1]!.map((row) => row.value)).toEqual([
    { revision: 1, sceneEpoch: expect.any(Number), observation: null },
    { revision: 2, sceneEpoch: expect.any(Number), observation: null },
  ]);
  expect(inputs[0]![0].input).not.toBe(inputs[1]![0].input);
  for (const rows of inputs)
    await expect(
      readFile(rows[0].input, { signal: AbortSignal.timeout(5000) }),
    ).rejects.toMatchObject({ code: "ENOENT" });
});

test("Explicit source suspension waits on one capture and resumes without Retry", async () => {
  await withRuntime(
    async ({
      publish,
      observation,
      children,
      footY,
      groundDistance,
      floor,
      status,
    }) => {
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      const sourcePID = (await children())[0]!;
      // A real public native status attachment enters the unchanged product
      // Receiver. No synthetic protocol reason bypasses its normalization.
      await publish({ sourceStatus: 3 });
      await expect.poll(groundDistance, { timeout: 3000 }).toBe(0);
      const until = performance.now() + 9000;
      while (performance.now() < until) {
        expect(await children()).toEqual([sourcePID]);
        expect(await groundDistance()).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await expect
        .poll(status)
        .toBe("Dock source suspended; waiting for updates");
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      expect(await children()).toEqual([sourcePID]);
    },
    { observation: null },
    "native-status",
  );
});

test("Unstable bottom contact stays grounded while stable overlap supports climbing", async () => {
  await withRuntime(
    async ({
      app,
      session,
      publish,
      observation,
      footY,
      groundDistance,
      floor,
      children,
    }) => {
      const originalPID = (await children())[0]!;
      const origin = await session.run("place-pet-at-ground", () =>
        app.evaluate(({ BrowserWindow, screen }) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          const area = screen.getPrimaryDisplay().workArea;
          const bounds = window.getBounds();
          window.setPosition(
            area.x + Math.round((area.width - bounds.width) / 2),
            area.y + area.height - bounds.height,
          );
          return window.getBounds();
        }),
      );
      expect(origin.width).toBe(240);
      const display = await session.run("observe-primary-display", () =>
        app.evaluate(({ screen }) => screen.getPrimaryDisplay()),
      );
      const bounds = () =>
        session.run("observe-pet-bounds", () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.getBounds(),
          ),
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
      await expect.poll(groundDistance, { timeout: 5000 }).toBe(0);
      // Same relative contour as the observed x615/start826 oscillation.
      // This overlaps the resting silhouette but misses stable bottom contact.
      await publish({ observation: bottom(origin.x + 211) });
      const until = performance.now() + 6500;
      while (performance.now() < until) {
        expect(await groundDistance()).toBe(0);
        expect((await bounds()).x).toBe(origin.x);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // The observed x615/start814 control is narrow but stably supported.
      await publish({ observation: bottom(origin.x + 199) });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(await footY()).toBe(floor - 75);
      await publish({ observation: null });
      await expect.poll(groundDistance, { timeout: 5000 }).toBe(0);
      await publish({ observation: bottom(origin.x + 260) });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await groundDistance()).toBe(0);
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
        expect(await groundDistance()).toBe(0);
        await publish({ observation: null });
      }
      expect(await children()).toEqual([originalPID]);
    },
  );
});

test("Dock capture rebuilds a continuously silent stream and restores support without manual Retry", async () => {
  await withRuntime(
    async ({
      publish,
      beginScene,
      footY,
      groundDistance,
      children,
      spawnedPIDs,
      floor,
      observation,
      app,
      session,
    }) => {
      const setupPID = (await children())[0]!;
      await session.run("replace-work-area", () =>
        app.evaluate(({ screen }) =>
          screen.emit(
            "display-metrics-changed",
            {},
            screen.getPrimaryDisplay(),
            ["workArea"],
          ),
        ),
      );
      await expect
        .poll(async () => {
          const owned = await children();
          return owned.length === 1 && owned[0] !== setupPID;
        })
        .toBe(true);
      await beginScene();
      const firstPID = (await children())[0]!;
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      await publish({ observation, silencePID: firstPID });
      await expect.poll(groundDistance, { timeout: 3000 }).toBe(0);
      await expect
        .poll(
          async () => {
            const owned = await children();
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
      session,
    }) => {
      const healthyPID = (await children())[0]!;
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      for (let index = 0; index < 5; index++) {
        await session.run(`empty-display-metrics:${index}`, () =>
          app.evaluate(({ screen }) =>
            screen.emit(
              "display-metrics-changed",
              {},
              screen.getPrimaryDisplay(),
              [],
            ),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(await children()).toEqual([healthyPID]);
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
      expect(await children()).toEqual([]);
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
      session,
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
      expect(await children()).toEqual([]);
      await session.run("power-suspend", () =>
        app.evaluate(({ powerMonitor }) => powerMonitor.emit("suspend")),
      );
      await session.run("power-resume", () =>
        app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume")),
      );
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(await children()).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(4);
      await invoke("Hide Mosey");
      await expect
        .poll(() =>
          session.run("observe-pet-visibility", () =>
            app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0]!.isVisible(),
            ),
          ),
        )
        .toBe(false);
      await expect.poll(status).toBe("Stopped");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await publish({ observation });
      await invoke("Retry Dock interaction");
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(await children()).toEqual([]);
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
      groundDistance,
      floor,
      invoke,
      app,
      session,
    }) => {
      await expect
        .poll(async () => (await spawnedPIDs()).length)
        .toBeGreaterThan(0);
      const initialPID = (await spawnedPIDs())[0]!;
      expect(await groundDistance()).toBe(0);
      await expect
        .poll(
          async () => {
            const owned = await children();
            return owned.length === 1 && owned[0] !== initialPID;
          },
          { timeout: 11000 },
        )
        .toBe(true);
      const healthyPID = (await children())[0]!;
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      await publish({
        observation,
        idle: true,
        reason: "idle_current",
        sourceAgeSeconds: 60,
      });
      await new Promise((resolve) => setTimeout(resolve, 5500));
      expect(await children()).toEqual([healthyPID]);
      expect(await footY()).toBe(floor - 75);
      await publish({ observation: null, reason: "alpha_empty" });
      await expect.poll(groundDistance).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 5500));
      expect(await children()).toEqual([healthyPID]);
      await publish({ reason: "callback_silence" });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await publish({ observation });
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      expect(await children()).toEqual([healthyPID]);
      await publish({ reason: "permission_lost" });
      await expect.poll(children, { timeout: 3000 }).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(await children()).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(2);
      await expect.poll(groundDistance).toBe(0);
      await publish({ observation });
      await invoke("Retry Dock interaction");
      await expect.poll(children).toHaveLength(1);
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      await publish({ reason: "permission_unavailable" });
      await expect.poll(children, { timeout: 3000 }).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(await children()).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(3);
      await session.run("power-suspend", () =>
        app.evaluate(({ powerMonitor }) => powerMonitor.emit("suspend")),
      );
      await publish({ observation });
      await invoke("Retry Dock interaction");
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(await children()).toEqual([]);
      expect(await spawnedPIDs()).toHaveLength(3);
      await session.run("power-resume", () =>
        app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume")),
      );
      await expect.poll(children).toHaveLength(1);
      await expect.poll(footY, { timeout: 5000 }).toBe(floor - 75);
      expect(await spawnedPIDs()).toHaveLength(4);
    },
    { startupSilence: true },
  );
});

test("Hidden, suspended and diagnostic ownership cancel queued rebuilds without replenishing the budget", async () => {
  await withRuntime(
    async ({
      publish,
      children,
      spawnedPIDs,
      invoke,
      app,
      status,
      session,
    }) => {
      const diagnostic = (label: string) =>
        session.run("diagnostic-menu", () =>
          app.evaluate(({ Menu }, label) => {
            Menu.getApplicationMenu()!
              .items.find((i) => i.label === "Dock validation")!
              .submenu!.items.find((i) => i.label === label)!
              .click();
          }, label),
        );
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
          await session.run("power-suspend", () =>
            app.evaluate(({ powerMonitor }) => powerMonitor.emit("suspend")),
          );
        else {
          const opened = session
            .run("diagnostic-window", () => app.waitForEvent("window"))
            .then(
              (panel) => ({ panel, error: undefined }),
              (error: unknown) => ({ panel: undefined, error }),
            );
          await diagnostic("Start Dock validation (120 seconds)");
          const result = await opened;
          if (!result.panel) throw result.error;
          const panel = result.panel;
          await session.run("diagnostic-heading", () =>
            panel.getByRole("heading", { name: "Dock validation" }).waitFor(),
          );
        }
        await expect.poll(children, { timeout: 4000 }).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(await children()).toEqual([]);
        expect(await spawnedPIDs()).toHaveLength(index + 1);
        if (pause === "hidden") await invoke("Show Mosey");
        else if (pause === "suspended")
          await session.run("power-resume", () =>
            app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume")),
          );
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
      const fourthPID = (await children())[0]!;
      await publish({ reason: "alpha_empty" });
      await new Promise((resolve) => setTimeout(resolve, 5600));
      expect(await children()).toEqual([fourthPID]);
      // The three old attempts have now been replenished by genuinely fresh
      // callbacks, despite having no visible alpha geometry to stand on.
      await publish({ reason: "callback_silence" });
      await expect
        .poll(async () => (await spawnedPIDs()).length, { timeout: 8000 })
        .toBe(5);
      await expect.poll(children).toHaveLength(1);
      const fifthPID = (await children())[0]!;
      // Merely changing the reason away from silence does not prove callbacks.
      await publish({ reason: "alpha_empty", callbackAgeSeconds: null });
      await new Promise((resolve) => setTimeout(resolve, 5600));
      expect(await children()).toEqual([fifthPID]);
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
