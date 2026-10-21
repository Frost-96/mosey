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
import path from "node:path";
import os from "node:os";
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
    app = await electron.launch(
      packaged
        ? {
            executablePath: path.join(root, "Mosey.app/Contents/MacOS/Mosey"),
            args: [`--user-data-dir=${root}/profile`],
          }
        : { args: [".", `--user-data-dir=${root}/profile`] },
    );
    applicationProcess = app.process();
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
    const invoke = (label: string) =>
      app!.evaluate(
        ({ Menu }, label) =>
          Menu.getApplicationMenu()!
            .items.find((i) => i.label === "Mosey")!
            .submenu!.items.find((i) => i.label === label)!
            .click(),
        label,
      );
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
    const size = (label: string) =>
      app!.evaluate(
        ({ Menu }, label) =>
          Menu.getApplicationMenu()!
            .items.find((i) => i.label === "Mosey")!
            .submenu!.items.find((i) => i.label === "Size")!
            .submenu!.items.find((i) => i.label === label)!
            .click(),
        label,
      );
    for (const [label, side] of [
      ["Small", 180],
      ["Medium", 240],
      ["Large", 300],
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
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isVisible(),
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
      app!.evaluate(
        ({ Menu }, label) =>
          Menu.getApplicationMenu()!
            .items.find((i) => i.label === "Dock validation")!
            .submenu!.items.find((i) => i.label === label)!
            .click(),
        label,
      );
    // Keep the owned product helper alive but stopped while the user selects
    // diagnostics then rapidly hides/shows. Capture ownership must be reserved
    // before its SIGKILL cleanup deadline, not after diagnostic startup.
    const productChild = children().find((item) =>
      item.command.endsWith("/dock-runtime"),
    );
    expect(productChild).toBeDefined();
    process.kill(productChild!.pid, "SIGSTOP");
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
          final: await bounds(),
          capture:
            "external synthetic native producer; no claim of physical Dock validation",
        },
        null,
        2,
      ),
    );
  } catch (error) {
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
