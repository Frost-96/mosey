import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startForge } from "./forge";
import {
  measure,
  measurementDirectory,
  recordMeasurement,
} from "./measurement";
import {
  copyPreparationInputs,
  digest,
  producerIdentity,
  sourceIdentity,
  treeDigest,
} from "../../tools/preparation-inputs";

export type PreparationLocator = { socketPath: string; runId: string };
export type PreparedApplication = {
  runId: string;
  preparationId: string;
  mode: "development" | "packaged";
  sourceRoot: string;
  appRoot: string;
  dependencyRoot: string;
  nativeRoot: string;
  cacheRoot: string;
  sourceId: string;
  producerId: string;
  manifest: string;
};
type Message = {
  runId: string;
  leaseId: string;
  action: "acquire" | "release";
  mode?: "development" | "packaged";
};
declare module "vitest" {
  interface ProvidedContext {
    moseyPreparation: PreparationLocator;
  }
}

// The host owns preparation. Workers receive data and a narrow local borrowing
// endpoint, never a process handle or another scenario's cancellation signal.
export async function createPreparationRun({
  sourceRoot = process.cwd(),
} = {}) {
  sourceRoot = path.resolve(sourceRoot);
  const directory = await mkdtemp(path.join(os.tmpdir(), "mosey-run-"));
  const locator = {
    socketPath: path.join(directory, "owner.sock"),
    runId: randomUUID(),
  };
  const cancellation = new AbortController();
  const preparations = new Map<string, Promise<PreparedApplication>>();
  const stops: (() => Promise<void>)[] = [];
  const acquisitions = new Set<Promise<PreparedApplication>>();
  const leases = new Map<
    string,
    { released: boolean; preparationId?: string }
  >();
  let closing = false;
  let closed: Promise<void> | undefined;
  let drained: (() => void) | undefined;
  const prepare = (mode: "development" | "packaged") => {
    const acquisition = (async () => {
      cancellation.signal.throwIfAborted();
      if (mode === "packaged") {
        try {
          await readFile(path.join(sourceRoot, "out/package-manifest.json"));
        } catch (error) {
          throw new Error(
            "Package producer manifest is required before borrowing",
            { cause: error },
          );
        }
      }
      const inputs = await measure("preparation.identify", {}, async () => ({
        source: await sourceIdentity(sourceRoot),
        producer: await producerIdentity(sourceRoot),
      }));
      cancellation.signal.throwIfAborted();
      const key = digest(
        JSON.stringify({
          mode,
          source: inputs.source.digest,
          producer: inputs.producer.digest,
        }),
      );
      let work = preparations.get(key);
      if (!work) {
        const preparationId = randomUUID();
        work = measure("run.prepare", { preparationId }, async () => {
          const generation = path.join(directory, preparationId);
          await measure("preparation.snapshot", {}, async () => {
            await copyPreparationInputs(sourceRoot, generation, inputs.source);
            if (
              (await treeDigest(
                path.join(generation, "node_modules"),
                ["."],
                true,
              )) !== inputs.producer.dependencies ||
              (await treeDigest(
                path.join(sourceRoot, "node_modules"),
                ["."],
                true,
              )) !== inputs.producer.dependencies
            )
              throw new Error(
                "Installed dependencies changed while taking the preparation snapshot",
              );
            // Test transformation bytes have a separate receipt. Freeze their
            // source alongside this generation so they cannot read tomorrow's
            // controller or Receiver from the checkout after borrowing today.
            for (const file of [
              "behavior-build.ts",
              "behavior-controller.ts",
              "native-runtime.ts",
            ]) {
              await mkdir(path.join(generation, "tests/support"), {
                recursive: true,
              });
              await cp(
                path.join(sourceRoot, "tests/support", file),
                path.join(generation, "tests/support", file),
              ).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              });
            }
          });
          cancellation.signal.throwIfAborted();
          if (mode === "development")
            stops.push(
              await startForge({
                cwd: generation,
                signal: cancellation.signal,
              }),
            );
          const appRoot =
            mode === "development"
              ? generation
              : path.join(sourceRoot, "out/Mosey-darwin-arm64/Mosey.app");
          const manifest = path.join(generation, "preparation.json");
          const receipt = {
            schema: 1,
            preparationId,
            mode,
            ...inputs,
            outputs:
              mode === "development"
                ? await treeDigest(generation, [
                    "src",
                    ".vite/build",
                    "build/native",
                  ])
                : null,
          };
          await writeFile(manifest, JSON.stringify(receipt, null, 2));
          const evidence = measurementDirectory();
          if (evidence)
            await cp(
              manifest,
              path.join(evidence, `preparation-${preparationId}.json`),
            );
          recordMeasurement("preparation-ready", {
            preparationId,
            mode,
            sourceId: inputs.source.digest,
            producerId: inputs.producer.digest,
            manifest,
          });
          return {
            runId: locator.runId,
            preparationId,
            mode,
            sourceRoot: generation,
            appRoot,
            dependencyRoot: path.join(generation, "node_modules"),
            nativeRoot: path.join(
              appRoot,
              mode === "development"
                ? "build/native"
                : "Contents/Resources/native",
            ),
            cacheRoot: path.join(generation, "build/swift-module-cache"),
            sourceId: inputs.source.digest,
            producerId: inputs.producer.digest,
            manifest,
          };
        });
        preparations.set(key, work);
      }
      return work;
    })();
    acquisitions.add(acquisition);
    void acquisition.then(
      () => acquisitions.delete(acquisition),
      () => acquisitions.delete(acquisition),
    );
    return acquisition;
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      let body = "";
      for await (const part of incoming) {
        body += part.toString();
        if (body.length > 8192)
          throw new Error("Preparation request is too large");
      }
      const message = JSON.parse(body) as Message;
      if (message.runId !== locator.runId || !message.leaseId)
        throw new Error("Unknown preparation run or lease");
      if (message.action === "release") {
        const lease = leases.get(message.leaseId);
        leases.set(message.leaseId, { ...lease, released: true });
        recordMeasurement("preparation-released", {
          leaseId: message.leaseId,
          preparationId: lease?.preparationId,
        });
        if ([...leases.values()].every((value) => value.released)) drained?.();
        outgoing.end(JSON.stringify({ ok: true }));
        return;
      }
      if (
        message.action !== "acquire" ||
        !["development", "packaged"].includes(message.mode ?? "")
      )
        throw new Error("Invalid preparation request");
      if (closing || leases.get(message.leaseId)?.released)
        throw new Error("Preparation run or borrow is closed");
      const lease = {
        released: false,
        preparationId: undefined as string | undefined,
      };
      leases.set(message.leaseId, lease);
      const prepared = await prepare(message.mode!);
      if (closing || leases.get(message.leaseId)?.released)
        throw new Error("Preparation run or borrow closed during acquisition");
      lease.preparationId = prepared.preparationId;
      recordMeasurement("preparation-borrowed", {
        leaseId: message.leaseId,
        preparationId: prepared.preparationId,
      });
      outgoing.end(JSON.stringify({ ok: true, prepared }));
    } catch (error) {
      outgoing.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(locator.socketPath, resolve);
  });
  return {
    locator,
    close() {
      if (closed) return closed;
      closing = true;
      cancellation.abort(new Error("Preparation run closed"));
      closed = (async () => {
        const errors: unknown[] = [];
        await Promise.allSettled([...acquisitions, ...preparations.values()]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if ([...leases.values()].some((value) => !value.released))
            await new Promise<void>((resolve, reject) => {
              drained = resolve;
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      "Preparation borrowers did not release within 10000ms",
                    ),
                  ),
                10000,
              );
            });
        } catch (error) {
          errors.push(error);
        } finally {
          clearTimeout(timer);
        }
        for (const stop of stops.toReversed()) {
          try {
            await stop();
          } catch (error) {
            errors.push(error);
          }
        }
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
        if (errors.length)
          throw new AggregateError(errors, "Preparation run cleanup failed");
      })();
      return closed;
    },
  };
}

function send(
  locator: PreparationLocator,
  message: Omit<Message, "runId">,
  timeout: number,
) {
  return new Promise<PreparedApplication | undefined>((resolve, reject) => {
    const outgoing = request(
      { socketPath: locator.socketPath, path: "/", method: "POST" },
      (incoming) => {
        let body = "";
        incoming.on("data", (part: Buffer) => {
          body += part.toString();
        });
        incoming.once("end", () => {
          try {
            const result = JSON.parse(body) as {
              ok: boolean;
              prepared?: PreparedApplication;
              error?: string;
            };
            if (!result.ok)
              reject(
                new Error(`Application preparation failed: ${result.error}`),
              );
            else resolve(result.prepared);
          } catch (error) {
            reject(error);
          }
        });
        incoming.once("error", reject);
      },
    );
    outgoing.setTimeout(timeout, () =>
      outgoing.destroy(
        new Error(`Preparation ${message.action} exceeded ${timeout}ms`),
      ),
    );
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify({ ...message, runId: locator.runId }));
  });
}

export async function borrowPreparedApplication(
  locator: PreparationLocator,
  mode: PreparedApplication["mode"],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const leaseId = randomUUID();
  let released: Promise<unknown> | undefined;
  const release = () =>
    (released ??= send(locator, { action: "release", leaseId }, 5000));
  const acquiring = send(locator, { action: "acquire", leaseId, mode }, 60000);
  let aborted: (() => void) | undefined;
  try {
    const prepared = await Promise.race([
      acquiring,
      new Promise<never>((_resolve, reject) => {
        aborted = () => reject(signal?.reason);
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
      }),
    ]);
    signal?.throwIfAborted();
    if (!prepared) throw new Error("Preparation owner returned no descriptor");
    return {
      ...prepared,
      release: async () => {
        await release();
      },
    };
  } catch (error) {
    const cleanup = await release().then(
      () => undefined,
      (releaseError: unknown) => ({ releaseError }),
    );
    if (cleanup)
      throw new AggregateError(
        [error, cleanup.releaseError],
        `Preparation acquisition failed (${String(error)}); late release also failed`,
        { cause: error },
      );
    throw error;
  } finally {
    if (aborted) signal?.removeEventListener("abort", aborted);
  }
}
