import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { createPreparationRun } from "./support/preparation";
import { preparationSourceFixture } from "./support/preparation-source-fixture";
import { createPetTestSession } from "./support/pet-session";
import { nativeRuntimeFixture } from "./support/native-runtime";

function firstNativeObservation(binary: string, signal: AbortSignal) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
    let pending = "",
      errorOutput = "";
    let value: Record<string, unknown> | undefined;
    let failure: unknown;
    const terminate = (error: unknown) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const cancelled = () => terminate(signal.reason);
    const timer = setTimeout(
      () => terminate(new Error("Native generation probe exceeded 5000ms")),
      5000,
    );
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    child.stdout.on("data", (bytes: Buffer) => {
      pending += bytes.toString();
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          if (row.type === "observation" && !value) {
            value = row;
            child.kill("SIGTERM");
          }
        } catch (error) {
          terminate(error);
        }
      }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      errorOutput = (errorOutput + bytes).slice(-8192);
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      if (failure) reject(failure);
      else if (code !== 0 || !value)
        reject(
          new Error(`Native generation probe failed: ${code}; ${errorOutput}`),
        );
      else resolve(value);
    });
  });
}

test("controller and native Receiver derivatives execute the borrowed source generation", async () => {
  const root = await preparationSourceFixture();
  const controller = path.join(root, "tests/support/behavior-controller.ts");
  await writeFile(
    controller,
    (await readFile(controller, "utf8")) +
      '\nReflect.set(globalThis, Symbol.for("mosey.preparation.source"), "controller-A");\n',
  );
  const native = path.join(root, "native/macos/dock-runtime.swift");
  await writeFile(
    native,
    (await readFile(native, "utf8")).replace(
      'return ["type": "observation", "elapsed": elapsed, "sequence": sequence,',
      'return ["type": "observation", "preparationSource": "receiver-A", "elapsed": elapsed, "sequence": sequence,',
    ),
  );
  const owner = await createPreparationRun({ sourceRoot: root });
  onTestFinished(() => owner.close());
  let receiverSource: unknown;
  const session = await createPetTestSession({
    preparation: owner.locator,
    behavior: { running: false },
    dock: {
      name: "generation-native-receiver",
      async prepare({ root, evidence, run, signal }) {
        const input = path.join(root, "input.json");
        await writeFile(
          input,
          JSON.stringify({ revision: 1, observation: null }),
        );
        const binary = await nativeRuntimeFixture(
          root,
          input,
          path.join(evidence, "native-generation.jsonl"),
          { run, signal },
        );
        receiverSource = (
          await firstNativeObservation(
            path.join(root, "native-source-fixture"),
            signal,
          )
        ).preparationSource;
        return binary;
      },
    },
  });
  const { app, renderer } = await session.launch();
  await renderer.waitUntilReady({ paintedPixels: 600 });
  const controllerSource = await session.run("controller-generation", () =>
    app.evaluate(() =>
      Reflect.get(globalThis, Symbol.for("mosey.preparation.source")),
    ),
  );
  await session.quit();
  await session.close();
  expect({ controllerSource, receiverSource }).toEqual({
    controllerSource: "controller-A",
    receiverSource: "receiver-A",
  });
});
