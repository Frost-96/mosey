import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// The fixture replaces the OS source only. The product Receiver, silhouette,
// mapping, clocks, process identity and stdout serialization run unchanged.
// No SCK enumeration, permission check or capture is started by this fixture.
export async function nativeRuntimeFixture(
  root: string,
  input: string,
  ledger: string,
): Promise<Buffer> {
  const production = await readFile("native/macos/dock-runtime.swift", "utf8");
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
  await writeFile(source, prefix + footer);
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-O",
      "-target",
      "arm64-apple-macos15.0",
      "-parse-as-library",
      "-module-cache-path",
      path.resolve("build/swift-module-cache"),
      source,
      "-o",
      binary,
    ],
    { timeout: 45000, maxBuffer: 32768 },
  );
  const result = await readFile(binary);
  await writeFile(
    path.join(root, "native-source-fixture-receipt.json"),
    JSON.stringify({
      prefixSHA256: createHash("sha256").update(prefix).digest("hex"),
      fixtureSHA256: createHash("sha256")
        .update(prefix + footer)
        .digest("hex"),
      binarySHA256: createHash("sha256").update(result).digest("hex"),
      boundary:
        "Synthetic source samples, actual production Receiver and stdout; no real capture",
    }),
  );
  return result;
}
