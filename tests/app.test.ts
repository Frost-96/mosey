import { test, expect } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PNG } from "pngjs";

const packaged = process.env.MOSEY_TEST_MODE === "packaged";
test("a real app displays one animated corgi and quits from its menu", async () => {
  let app: ElectronApplication | undefined;
  let server: ChildProcess | undefined;
  const errors: string[] = [];
  let shim: string | undefined;
  try {
    if (!packaged) {
      shim = await mkdtemp(path.join(os.tmpdir(), "mosey-forge-"));
      const executable = path.join(
        shim,
        "Electron.app/Contents/MacOS/Electron",
      );
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(
        executable,
        "#!/bin/sh\necho MOSEY_TEST_READY\nexec /bin/cat\n",
      );
      await chmod(executable, 0o755);
      server = spawn("pnpm", ["start"], {
        env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: shim },
        stdio: "pipe",
        detached: true,
      });
      let output = "";
      server.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      server.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      await expect
        .poll(
          () => {
            if (server?.exitCode !== null) throw new Error(output);
            return output;
          },
          { timeout: 60000 },
        )
        .toContain("MOSEY_TEST_READY");
    }
    app = await electron.launch(
      packaged
        ? {
            timeout: 20000,
            executablePath: path.resolve(
              "out/Mosey-darwin-arm64/Mosey.app/Contents/MacOS/Mosey",
            ),
          }
        : { args: ["."], timeout: 20000 },
    );
    const window = await app.firstWindow({ timeout: 15000 });
    window.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error.message);
    });
    window.on("console", (message) =>
      console.log(message.type(), message.text()),
    );
    expect(app.windows()).toHaveLength(1);
    await expect
      .poll(
        async () =>
          window.evaluate(() => {
            const canvas = document.querySelector("canvas");
            if (!canvas) return 0;
            const pixels = canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height).data;
            return Array.from(pixels).filter(
              (value, i) => i % 4 === 3 && value > 127,
            ).length;
          }),
        { timeout: 10000 },
      )
      .toBeGreaterThan(5000);
    // A second launch must exit without adding a pet or terminating the first.
    const duplicate = spawn(app.process().spawnfile, packaged ? [] : ["."], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: "ignore",
    });
    try {
      await expect.poll(() => duplicate.exitCode, { timeout: 10000 }).toBe(0);
      expect(app.windows()).toHaveLength(1);
      expect(await window.evaluate(() => document.body.innerText)).toBe("");
    } finally {
      if (duplicate.exitCode === null) duplicate.kill();
    }
    expect(
      await window.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const data = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let bottom = -1;
        for (let y = 0; y < canvas.height; y++)
          for (let x = 0; x < canvas.width; x++)
            if (data[(y * canvas.width + x) * 4 + 3] > 127) bottom = y;
        return Math.round((bottom + 1) / globalThis.devicePixelRatio);
      }),
    ).toBe(240);
    const capture = async () =>
      PNG.sync.read(await window.screenshot({ omitBackground: true }));
    const first = await capture();
    expect(first.data.some((value, i) => i % 4 === 3 && value > 127)).toBe(
      true,
    );
    await expect
      .poll(async () => (await capture()).data.equals(first.data), {
        timeout: 5000,
        interval: 75,
      })
      .toBe(false);
    expect(
      await window.evaluate(() => typeof Reflect.get(window, "require")),
    ).toBe("undefined");
    const preload = await app.evaluate(({ app }) =>
      process
        .getBuiltinModule("node:fs")
        .readFileSync(app.getAppPath() + "/.vite/build/preload.cjs", "utf8"),
    );
    expect(preload).not.toMatch(/^import |^export /m);
    const runtime = await app.evaluate(() => ({
      node: process.versions.node,
      electron: process.versions.electron,
    }));
    expect(runtime).toEqual({ node: "24.22.0", electron: "44.9.1" });
    expect(errors).toEqual([]);
    await mkdir("test-results", { recursive: true });
    await window.screenshot({
      path: `test-results/${packaged ? "packaged" : "development"}-corgi.png`,
      omitBackground: true,
    });
    const child = app.process();
    const closed = new Promise<void>((resolve) =>
      app!.once("close", () => resolve()),
    );
    await app.evaluate(({ Menu }) => {
      const quit = Menu.getApplicationMenu()
        ?.items.find((item) => item.label === "Mosey")
        ?.submenu?.items.find((item) => item.label === "Quit Mosey");
      if (!quit) throw new Error("Quit Mosey menu item is absent");
      quit.click();
    });
    await closed;
    await expect.poll(() => child.exitCode).toBe(0);
    await writeFile(
      `test-results/${packaged ? "packaged" : "development"}-runtime.json`,
      JSON.stringify(runtime, null, 2),
    );
  } catch (error) {
    await mkdir("test-results", { recursive: true });
    for (const [i, window] of (app?.windows() ?? []).entries())
      await window
        .screenshot({
          path: `test-results/failure-${packaged ? "packaged" : "development"}-${i}.png`,
        })
        .catch(() => {});
    throw error;
  } finally {
    await app?.close().catch(() => {});
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
      await new Promise<void>((resolve) => {
        if (server!.exitCode !== null || server!.signalCode !== null)
          return resolve();
        server!.once("exit", () => resolve());
      });
    }
    if (shim) await rm(shim, { recursive: true, force: true });
  }
});
