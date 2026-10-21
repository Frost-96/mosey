import AppKit
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ScreenCaptureKit

// Product-only capture. No pixels, screenshots, audio, permission requests or Dock
// preferences cross this process. Mapping is deliberately limited to the uniquely
// isolated primary-screen Dock host demonstrated by the #14 experiment.
var timebase = mach_timebase_info_data_t()
func age(_ now: UInt64, _ before: UInt64) -> Double {
    (now >= before ? 1 : -1) * Double(now >= before ? now - before : before - now)
        * Double(timebase.numer) / Double(timebase.denom) / 1_000_000_000
}
func rect(_ r: CGRect) -> [String: Double] {
    ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
}
func attachmentRect(_ value: Any?) -> CGRect? {
    guard let d = value as? [String: Any] else { return nil }
    func n(_ key: String) -> Double? {
        (d[key] as? NSNumber)?.doubleValue ?? (d[key.prefix(1).uppercased() + key.dropFirst()] as? NSNumber)?.doubleValue
    }
    guard let x = n("x"), let y = n("y"), let w = n("width"), let h = n("height"),
          [x, y, w, h].allSatisfy({ $0.isFinite }) else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}
final class Output: @unchecked Sendable {
    let lock = NSLock()
    func emit(_ record: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]), data.count <= 512 * 1024 else { _exit(70) }
        do {
            try FileHandle.standardOutput.write(contentsOf: data)
            try FileHandle.standardOutput.write(contentsOf: Data([10]))
        } catch { _exit(74) }
    }
}
struct Silhouette {
    var observation: [String: Any]?
    var reason: String
}

// Alpha >=128 and four-connected components match the independently compared
// research capture. Allocate the flood fill only inside the nonempty alpha bbox,
// bounded at four million pixels rather than allocating one stack per full screen.
func silhouette(_ buffer: CVPixelBuffer, primary: CGRect, scale: Double, display: CGDirectDisplayID) -> Silhouette {
    guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA,
          CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else {
        return Silhouette(reason: "pixel_format_unavailable")
    }
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer), stride = CVPixelBufferGetBytesPerRow(buffer)
    guard width > 0, height > 0, width <= 16384, height <= 16384, width * height <= 50_000_000,
          let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) else {
        return Silhouette(reason: "raster_resource_limit")
    }
    var x0 = width, y0 = height, x1 = -1, y1 = -1, selected = 0
    for y in 0..<height { for x in 0..<width where base[y * stride + x * 4 + 3] >= 128 {
        x0 = min(x0, x); y0 = min(y0, y); x1 = max(x1, x); y1 = max(y1, y); selected += 1
    } }
    guard selected > 0 else { return Silhouette(reason: "alpha_empty") }
    guard selected < width * height else { return Silhouette(reason: "alpha_not_isolated") }
    let cropWidth = x1 - x0 + 1, cropHeight = y1 - y0 + 1
    guard cropWidth * cropHeight <= 4_000_000 else { return Silhouette(reason: "alpha_resource_limit") }
    var mask = [UInt8](repeating: 0, count: cropWidth * cropHeight)
    for y in 0..<cropHeight { for x in 0..<cropWidth {
        mask[y * cropWidth + x] = base[(y + y0) * stride + (x + x0) * 4 + 3] >= 128 ? 1 : 0
    } }
    var bestSize = 0, bestPoints: [Int32] = [], stack: [Int32] = []
    var points: [Int32] = []
    for seed in mask.indices where mask[seed] != 0 {
        stack.append(Int32(seed)); mask[seed] = 0; points.removeAll(keepingCapacity: true)
        while let stored = stack.popLast() {
            let index = Int(stored), x = index % cropWidth, y = index / cropWidth
            points.append(stored)
            func enqueue(_ i: Int) { if mask[i] != 0 { mask[i] = 0; stack.append(Int32(i)) } }
            if x > 0 { enqueue(index - 1) }; if x + 1 < cropWidth { enqueue(index + 1) }
            if y > 0 { enqueue(index - cropWidth) }; if y + 1 < cropHeight { enqueue(index + cropWidth) }
        }
        if points.count > bestSize { bestSize = points.count; bestPoints = points }
    }
    var bx0 = width, by0 = height, bx1 = -1, by1 = -1
    for stored in bestPoints {
        let index = Int(stored), x = x0 + index % cropWidth, y = y0 + index / cropWidth
        bx0 = min(bx0, x); by0 = min(by0, y); bx1 = max(bx1, x); by1 = max(by1, y)
    }
    let w = Double(bx1 - bx0 + 1) / scale, h = Double(by1 - by0 + 1) / scale
    // A detached tooltip, menu or arbitrary full-screen host is not a Dock. The
    // actual connected alpha shape must extend toward exactly one relevant edge.
    // 24 DIP is a recognition tolerance for Dock inset/shadow, never a stand-in
    // support coordinate: every returned inward coordinate still comes from alpha.
    let bottomGap = Double(height - by1 - 1) / scale
    let leftGap = Double(bx0) / scale, rightGap = Double(width - bx1 - 1) / scale
    let bottom = w > h * 1.2 && bottomGap <= 24
    let left = h > w * 1.2 && leftGap <= 24
    let right = h > w * 1.2 && rightGap <= 24
    guard [bottom, left, right].filter({ $0 }).count == 1 else { return Silhouette(reason: "orientation_ambiguous_or_detached") }
    let orientation = bottom ? "bottom" : (left ? "left" : "right")
    let bins = Int(ceil(bottom ? primary.width : primary.height))
    guard bins > 0, bins <= 16384 else { return Silhouette(reason: "contour_resource_limit") }
    var inward = [Double?](repeating: nil, count: bins)
    for stored in bestPoints {
        let index = Int(stored), x = x0 + index % cropWidth, y = y0 + index / cropWidth
        let axis = Int(floor(Double(bottom ? x : y) / scale))
        guard axis >= 0, axis < bins else { return Silhouette(reason: "mapping_out_of_bounds") }
        let value = Double(bottom ? y : (left ? x + 1 : x)) / scale + (bottom ? primary.minY : primary.minX)
        if let previous = inward[axis] { inward[axis] = left ? max(previous, value) : min(previous, value) }
        else { inward[axis] = value }
    }
    let contour: [[String: Double]] = inward.enumerated().compactMap { axis, value in
        value.map { ["axis": Double(axis) + (bottom ? primary.minX : primary.minY), "inward": $0] }
    }
    let bounds = CGRect(x: primary.minX + Double(bx0) / scale, y: primary.minY + Double(by0) / scale, width: w, height: h)
    return Silhouette(observation: ["orientation": orientation, "bounds": rect(bounds), "contour": contour, "primaryDisplayID": display], reason: "current")
}
final class Receiver: NSObject, SCStreamOutput, SCStreamDelegate {
    struct Job {
        let sample: CMSampleBuffer
        let info: [SCStreamFrameInfo: Any]
        let source: UInt64?
        let epoch: Int
        let sequence: Int
    }
    let lock = NSLock()
    let worker = DispatchQueue(label: "mosey.dock.runtime.alpha", qos: .utility)
    let primary: CGRect, scale: Double, display: CGDirectDisplayID
    let width: Int, height: Int
    let clearBackground = CGColor(gray: 0, alpha: 0)
    var active = true, busy = false
    var epoch = 0, sequence = 0, acceptedSequence = -1
    var pending: Job?
    var lastCallback: UInt64?, source: UInt64?
    var lastStatus = -1
    var shape = Silhouette(reason: "waiting_for_complete_frame")
    var streamFailed = false
    init(primary: CGRect, scale: Double, display: CGDirectDisplayID) {
        self.primary = primary; self.scale = scale; self.display = display
        width = Int((primary.width * scale).rounded()); height = Int((primary.height * scale).rounded())
    }
    func clearLocked(_ reason: String) {
        shape = Silhouette(reason: reason); source = nil; acceptedSequence = -1
    }
    func invalidate(_ reason: String) {
        lock.lock(); active = false; epoch += 1; pending = nil; clearLocked(reason); lock.unlock()
    }
    func stop() {
        lock.lock(); active = false; epoch += 1; pending = nil; clearLocked("stopped"); lock.unlock()
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock(); active = false; streamFailed = true; epoch += 1; pending = nil; clearLocked("stream_error"); lock.unlock()
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        let now = mach_absolute_time()
        let info = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first ?? [:]
        let status = (info[.status] as? NSNumber)?.intValue ?? -1
        lock.lock()
        if let previous = lastCallback, age(now, previous) > 0.75 {
            epoch += 1; pending = nil; clearLocked("callback_silence")
        }
        lastCallback = now; lastStatus = status
        guard active else { lock.unlock(); return }
        guard status == SCFrameStatus.complete.rawValue else {
            if status != SCFrameStatus.idle.rawValue { epoch += 1; pending = nil; clearLocked("incomplete_frame") }
            lock.unlock(); return
        }
        sequence += 1
        clearLocked("new_complete_pending")
        let job = Job(sample: sampleBuffer, info: info, source: (info[.displayTime] as? NSNumber)?.uint64Value, epoch: epoch, sequence: sequence)
        if busy { pending = job; lock.unlock(); return }
        busy = true; lock.unlock()
        worker.async { [self] in
            var next: Job? = job
            while let current = next {
                process(current)
                lock.lock(); next = active ? pending : nil; pending = nil
                if next == nil { busy = false }; lock.unlock()
            }
        }
    }
    func process(_ job: Job) {
        lock.lock(); let eligible = active && job.epoch == epoch && job.sequence == sequence; lock.unlock()
        let now = mach_absolute_time()
        guard eligible, let timestamp = job.source, age(now, timestamp) >= 0, age(now, timestamp) <= 1 else { return }
        let content = attachmentRect(job.info[.contentRect])
        let frameScale = (job.info[.scaleFactor] as? NSNumber)?.doubleValue
        let contentScale = (job.info[.contentScale] as? NSNumber)?.doubleValue
        guard let buffer = CMSampleBufferGetImageBuffer(job.sample), CMSampleBufferIsValid(job.sample),
              let content, abs(content.minX) < 0.01, abs(content.minY) < 0.01,
              abs(content.width - primary.width) < 0.01, abs(content.height - primary.height) < 0.01,
              frameScale == scale, contentScale == 1,
              CVPixelBufferGetWidth(buffer) == width, CVPixelBufferGetHeight(buffer) == height else {
            lock.lock(); if job.epoch == epoch && job.sequence == sequence { clearLocked("mapping_unreliable") }; lock.unlock(); return
        }
        let result = silhouette(buffer, primary: primary, scale: scale, display: display)
        let finished = mach_absolute_time()
        lock.lock(); defer { lock.unlock() }
        guard active, job.epoch == epoch, job.sequence == sequence, age(finished, timestamp) >= 0, age(finished, timestamp) <= 1,
              let callback = lastCallback, age(finished, callback) >= 0, age(finished, callback) <= 0.75 else { return }
        shape = result; source = timestamp; acceptedSequence = job.sequence
    }
    func failed() -> Bool {
        lock.lock(); defer { lock.unlock() }; return streamFailed
    }
    func snapshot(_ elapsed: Double) -> [String: Any] {
        let now = mach_absolute_time()
        lock.lock(); defer { lock.unlock() }
        let callbackAge = lastCallback.map { age(now, $0) }
        let sourceAge = source.map { age(now, $0) }
        let idle = lastStatus == SCFrameStatus.idle.rawValue
        if active && (callbackAge.map({ $0 < 0 || $0 > 0.75 }) ?? true) {
            epoch += 1; pending = nil; clearLocked("callback_silence")
        } else if active && (acceptedSequence != sequence || pending != nil || !(sourceAge.map({ $0 >= 0 && ($0 <= 1 || idle) }) ?? false)) {
            clearLocked(shape.reason == "current" ? "stale_source" : shape.reason)
        }
        return ["type": "observation", "elapsed": elapsed, "sequence": sequence,
                "sourceAgeSeconds": sourceAge.flatMap { $0 >= 0 ? $0 : nil } as Any? ?? NSNull(),
                "callbackAgeSeconds": callbackAge.flatMap { $0 >= 0 ? $0 : nil } as Any? ?? NSNull(),
                "idle": idle, "reason": shape.observation != nil && idle ? "idle_current" : shape.reason,
                "observation": shape.observation as Any? ?? NSNull()]
    }
}
@main struct DockRuntime {
    @MainActor static func main() async {
        mach_timebase_info(&timebase)
        let parent = getppid()
        // This independent watchdog remains live even if stdout blocks. A helper
        // cannot survive its owning application and become a separate daemon.
        let parentTimer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        parentTimer.schedule(deadline: .now() + 1, repeating: 1)
        parentTimer.setEventHandler { if getppid() != parent { _exit(0) } }; parentTimer.resume()
        let output = Output(), start = mach_absolute_time()
        output.emit(["type": "environment", "protocol": 1, "processID": getpid(), "parentPID": parent])
        func unavailable(_ reason: String) {
            output.emit(["type": "observation", "elapsed": age(mach_absolute_time(), start), "sequence": 0,
                         "sourceAgeSeconds": NSNull(), "callbackAgeSeconds": NSNull(), "idle": false,
                         "reason": reason, "observation": NSNull()])
        }
        guard CGPreflightScreenCaptureAccess() else { unavailable("permission_unavailable"); exit(2) }
        var capture: SCStream?, receiver: Receiver?
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            let display = CGMainDisplayID(), primary = CGDisplayBounds(display)
            guard let screen = NSScreen.screens.first(where: {
                ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display
            }) else { unavailable("primary_display_unavailable"); exit(2) }
            let scale = screen.backingScaleFactor, originalFrame = screen.frame
            let candidates = content.windows.filter {
                $0.owningApplication?.bundleIdentifier == "com.apple.dock" && $0.windowLayer == 20 &&
                abs($0.frame.minX - primary.minX) < 1 && abs($0.frame.minY - primary.minY) < 1 &&
                abs($0.frame.width - primary.width) < 1 && abs($0.frame.height - primary.height) < 1
            }
            let onScreen = candidates.filter { $0.isOnScreen }
            guard let window = candidates.count == 1 ? candidates.first : (onScreen.count == 1 ? onScreen.first : nil) else {
                unavailable("dock_host_ambiguous_or_unavailable"); exit(2)
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            guard filter.pointPixelScale == Float(scale), abs(filter.contentRect.width - primary.width) < 1,
                  abs(filter.contentRect.height - primary.height) < 1 else {
                unavailable("filter_mapping_unreliable"); exit(2)
            }
            let sink = Receiver(primary: primary, scale: scale, display: display); receiver = sink
            let config = SCStreamConfiguration()
            config.width = sink.width; config.height = sink.height
            config.pixelFormat = kCVPixelFormatType_32BGRA; config.shouldBeOpaque = false
            config.backgroundColor = sink.clearBackground; config.showsCursor = false
            config.capturesAudio = false; config.queueDepth = 3; config.captureDynamicRange = .SDR
            config.ignoreShadowsSingleWindow = true; config.ignoreGlobalClipSingleWindow = false
            config.scalesToFit = false; config.preservesAspectRatio = true
            config.minimumFrameInterval = CMTime(seconds: 0.1, preferredTimescale: 600)
            let stream = SCStream(filter: filter, configuration: config, delegate: sink); capture = stream
            try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "mosey.dock.runtime.callback", qos: .userInitiated))
            try await stream.startCapture()
            var nextHostCheck = 0.0
            while true {
                try await Task.sleep(nanoseconds: 100_000_000)
                let elapsed = age(mach_absolute_time(), start)
                guard CGPreflightScreenCaptureAccess() else { sink.invalidate("permission_lost"); break }
                guard CGMainDisplayID() == display, CGDisplayBounds(display) == primary,
                      let current = NSScreen.screens.first(where: {
                          ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display
                      }), current.frame == originalFrame, current.backingScaleFactor == scale else {
                    sink.invalidate("display_configuration_changed"); break
                }
                if elapsed >= nextHostCheck {
                    nextHostCheck = elapsed + 1
                    // CG frame/layer establish capture identity only, never a support
                    // edge. A replaced/moved host must not preserve old alpha geometry.
                    let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
                    let matching = list.filter { item in
                        guard (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == window.owningApplication?.processID,
                              (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 20,
                              let dictionary = item[kCGWindowBounds as String] as? [String: Any],
                              let frame = CGRect(dictionaryRepresentation: dictionary as CFDictionary) else { return false }
                        return frame == window.frame
                    }
                    let onScreenMatching = matching.filter { ($0[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true }
                    let currentHost = matching.count == 1 ? matching.first : (onScreenMatching.count == 1 ? onScreenMatching.first : nil)
                    guard let currentHost,
                          (currentHost[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window.windowID else {
                        sink.invalidate("dock_host_changed"); break
                    }
                }
                let record = sink.snapshot(elapsed); output.emit(record)
                if sink.failed() { break }
            }
            output.emit(sink.snapshot(age(mach_absolute_time(), start)))
            sink.stop(); try? await stream.stopCapture()
            await withCheckedContinuation { continuation in sink.worker.async { continuation.resume() } }
        } catch {
            receiver?.invalidate("capture_error")
            if let receiver { output.emit(receiver.snapshot(age(mach_absolute_time(), start))) }
            else { unavailable("capture_error") }
            if let capture { try? await capture.stopCapture() }
        }
        withExtendedLifetime(parentTimer) {}
        exit(2)
    }
}
