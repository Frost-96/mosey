import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProducerOperation } from "./dock-producer";
import { measure } from "./measurement";
import { nativeToolchainIdentity } from "../../tools/preparation-inputs";
import { preparationSource } from "./preparation-source";

const fixtureTransformSHA256 = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");

// A cancelled compile owns its process group until the compiler has exited;
// its frontend children must not keep writing into an already released cache.
function compileNative(args: string[], journal: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return measure(
    "native.fixture-compile",
    {},
    () =>
      new Promise<void>((resolve, reject) => {
        const compiler = spawn("/usr/bin/xcrun", args, {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let failure: unknown;
        let output = "";
        const record = (event: string, detail?: unknown) => {
          try {
            appendFileSync(
              journal,
              JSON.stringify({
                event,
                pid: compiler.pid,
                group: compiler.pid,
                at: Date.now(),
                ...(detail as object),
              }) + "\n",
            );
          } catch (error) {
            failure ??= error;
          }
        };
        record("compiler-spawned");
        const terminate = (reason: unknown) => {
          failure ??= reason;
          if (!compiler.pid) return;
          record("compiler-signal", { signal: "SIGKILL" });
          try {
            process.kill(-compiler.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
              failure = error;
          }
        };
        const cancelled = () => terminate(signal?.reason);
        const timer = setTimeout(
          () =>
            terminate(
              new Error("Native producer compilation exceeded 45000ms"),
            ),
          45000,
        );
        signal?.addEventListener("abort", cancelled, { once: true });
        const capture = (bytes: Buffer) => {
          output = (output + bytes.toString("utf8")).slice(-32768);
        };
        compiler.stdout.on("data", capture);
        compiler.stderr.on("data", capture);
        compiler.once("error", (error) => {
          failure ??= error;
        });
        compiler.once("close", (code, exitSignal) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancelled);
          try {
            const live = compiler.pid
              ? execFileSync("/bin/ps", ["-axo", "pid=,pgid=,state=,comm="], {
                  encoding: "utf8",
                  timeout: 5000,
                })
                  .split("\n")
                  .filter((row) => {
                    const fields = row.trim().split(/\s+/);
                    return (
                      Number(fields[1]) === compiler.pid &&
                      !fields[2]!.startsWith("Z")
                    );
                  })
              : [];
            record("compiler-exited", { code, signal: exitSignal, live });
            if (live.length)
              failure ??= new Error(
                `Owned native compiler group survived: ${live.join("; ")}`,
              );
          } catch (error) {
            failure ??= error;
          }
          if (failure !== undefined) reject(failure);
          else if (code !== 0)
            reject(
              new Error(
                `Native producer compilation failed: code=${code}, signal=${exitSignal}\n${output}`,
              ),
            );
          else resolve();
        });
      }),
  );
}

// The fixture replaces the OS source only. The product Receiver, silhouette,
// mapping, clocks, process identity and stdout serialization run unchanged.
// No SCK enumeration, permission check or capture is started by this fixture.
export async function nativeRuntimeFixture(
  root: string,
  input: string,
  ledger: string,
  { run, signal }: { run?: ProducerOperation; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const operation: ProducerOperation =
    run ??
    (async (_label, action) => {
      signal?.throwIfAborted();
      const value = await action();
      signal?.throwIfAborted();
      return value;
    });
  const prepared = preparationSource();
  const production = await operation("native-source-read", () =>
    readFile(
      path.join(prepared.sourceRoot, "native/macos/dock-runtime.swift"),
      "utf8",
    ),
  );
  const marker = "@main struct DockRuntime {";
  if (production.split(marker).length !== 2)
    throw new Error("Native fixture cannot isolate the production entry point");
  const prefix = production.slice(0, production.indexOf(marker));
  const footer = `
@main struct SyntheticSource {
    static func main() throws {
        mach_timebase_info(&timebase)
        let start = mach_absolute_time(), output = Output()
        let input = ${JSON.stringify(input)}, ledger = ${JSON.stringify(ledger)}
        func record(_ event: String, _ detail: [String: Any] = [:]) {
            var row = detail; row["event"] = event; row["pid"] = getpid(); row["ppid"] = getppid()
            row["at"] = Date().timeIntervalSince1970 * 1000
            row["monotonic"] = age(mach_absolute_time(), start) * 1000
            guard let data = try? JSONSerialization.data(withJSONObject: row) else { return }
            let fd = open(ledger, O_WRONLY | O_CREAT | O_APPEND, 0o600)
            if fd >= 0 { data.withUnsafeBytes { _ = write(fd, $0.baseAddress, $0.count) }; _ = write(fd, "\\n", 1); close(fd) }
        }
        record("spawn")
        signal(SIGTERM, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        termination.setEventHandler { record("SIGTERM"); record("exit", ["code": 0]); exit(0) }
        termination.resume()
        // Public display geometry only, never window/source enumeration or pixels.
        let display = CGMainDisplayID(), primary = CGDisplayBounds(display)
        let width = Int(primary.width.rounded()), height = Int(primary.height.rounded())
        let receiver = Receiver(primary: primary, scale: 1, display: display)
        let stream = SCStream(filter: SCContentFilter(), configuration: SCStreamConfiguration(), delegate: nil)
        output.emit(["type": "environment", "protocol": 1, "processID": getpid(), "parentPID": getppid()])
        var revision = -1
        func sample(_ status: Int, _ bounds: CGRect?) throws -> CMSampleBuffer {
            var buffer: CVPixelBuffer?
            guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, nil, &buffer) == kCVReturnSuccess,
                  let buffer else { throw NSError(domain: "fixture-buffer", code: 1) }
            CVPixelBufferLockBaseAddress(buffer, [])
            if let base = CVPixelBufferGetBaseAddress(buffer) {
                let stride = CVPixelBufferGetBytesPerRow(buffer)
                memset(base, 0, stride * height)
                if let bounds {
                    for y in max(0, Int(bounds.minY - primary.minY))..<min(height, Int(bounds.maxY - primary.minY)) {
                        for x in max(0, Int(bounds.minX - primary.minX))..<min(width, Int(bounds.maxX - primary.minX)) {
                            base.storeBytes(of: UInt8(255), toByteOffset: y * stride + x * 4 + 3, as: UInt8.self)
                        }
                    }
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            var format: CMVideoFormatDescription?
            guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &format) == noErr,
                  let format else { throw NSError(domain: "fixture-format", code: 1) }
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 10), presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
            var result: CMSampleBuffer?
            guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &result) == noErr,
                  let result,
                  let attachments = CMSampleBufferGetSampleAttachmentsArray(result, createIfNecessary: true) as? [NSMutableDictionary],
                  let first = attachments.first else { throw NSError(domain: "fixture-sample", code: 1) }
            first[SCStreamFrameInfo.status.rawValue] = NSNumber(value: status)
            first[SCStreamFrameInfo.displayTime.rawValue] = NSNumber(value: mach_absolute_time())
            first[SCStreamFrameInfo.contentRect.rawValue] = ["X": 0, "Y": 0, "Width": primary.width, "Height": primary.height]
            first[SCStreamFrameInfo.scaleFactor.rawValue] = NSNumber(value: 1)
            first[SCStreamFrameInfo.contentScale.rawValue] = NSNumber(value: 1)
            return result
        }
        while age(mach_absolute_time(), start) < 125 {
            Thread.sleep(forTimeInterval: 0.1)
            let value = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: input))) as! [String: Any]
            let next = (value["revision"] as? NSNumber)?.intValue ?? -1
            let changed = next != revision
            if changed { revision = next; record("input", ["value": value, "revision": revision]) }
            let status = (value["sourceStatus"] as? NSNumber)?.intValue
            if status == SCFrameStatus.suspended.rawValue {
                if changed { receiver.stream(stream, didOutputSampleBuffer: try sample(status!, nil), of: .screen) }
                output.emit(receiver.snapshot(age(mach_absolute_time(), start)))
                continue
            }
            output.emit(receiver.snapshot(age(mach_absolute_time(), start)))
            if let observation = value["observation"] as? [String: Any],
               let bounds = observation["bounds"] as? [String: Double],
               let x = bounds["x"], let y = bounds["y"], let width = bounds["width"], let height = bounds["height"] {
                receiver.stream(stream, didOutputSampleBuffer: try sample(SCFrameStatus.complete.rawValue, CGRect(x: x, y: y, width: width, height: height)), of: .screen)
            } else {
                receiver.stream(stream, didOutputSampleBuffer: try sample(SCFrameStatus.idle.rawValue, nil), of: .screen)
            }
        }
        receiver.stop(); record("exit", ["code": 0])
        withExtendedLifetime(termination) {}; withExtendedLifetime(stream) {}
    }
}
`;
  const source = path.join(root, "native-source-fixture.swift");
  const binary = path.join(root, "native-source-fixture");
  await operation("native-source-write", () =>
    writeFile(source, prefix + footer),
  );
  const moduleCache = path.join(root, "swift-module-cache");
  const toolchain = await operation("native-toolchain", () =>
    nativeToolchainIdentity(),
  );
  await operation(
    "native-compile",
    () =>
      compileNative(
        [
          "swiftc",
          "-O",
          "-target",
          "arm64-apple-macos15.0",
          "-parse-as-library",
          "-module-cache-path",
          moduleCache,
          source,
          "-o",
          binary,
        ],
        `${ledger}.compiler.jsonl`,
        signal,
      ),
    { timeout: 45000 },
  );
  const result = await operation("native-binary-read", () => readFile(binary));
  await operation("native-receipt-write", () =>
    writeFile(
      path.join(root, "native-source-fixture-receipt.json"),
      JSON.stringify({
        parentPreparation: prepared.preparationId,
        productionSource: prepared.sourceId,
        fixtureTransformSHA256,
        prefixSHA256: createHash("sha256").update(prefix).digest("hex"),
        fixtureSHA256: createHash("sha256")
          .update(prefix + footer)
          .digest("hex"),
        binarySHA256: createHash("sha256").update(result).digest("hex"),
        compiler: {
          ...toolchain,
          moduleCache,
          target: "arm64-apple-macos15.0",
        },
        boundary:
          "Synthetic source samples, actual production Receiver and stdout; no real capture",
      }),
    ),
  );
  return result;
}
