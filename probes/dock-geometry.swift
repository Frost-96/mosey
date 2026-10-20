import AppKit
import ApplicationServices
import Foundation

// Derived from macos-environment.swift: read-only Dock/permission/display diagnostics.
// No request-access APIs, preference writes, screenshots, or private symbols.
struct Options {
    var scenario = "baseline"
    var duration = 10.0
    var interval = 0.2
    var overlay = true
}
func usage() {
    print("""
    dock-geometry [--scenario baseline|hidden|shown|magnification|left|right|permission-denied|permission-revoked]
                  [--duration 0.1..120] [--interval 0.05..5] [--no-overlay]
    Emits bounded JSONL evidence to stdout. Move/show/hide/configure the Dock yourself.
    Amber overlay = unverified AX candidate; never a product support edge.
    No permission prompts or system preference writes. Ctrl-C stops immediately.
    """)
}
func invalid(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(64)
}
var options = Options()
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let flag = args.removeFirst()
    if flag == "--help" { usage(); exit(0) }
    if flag == "--no-overlay" { options.overlay = false; continue }
    guard !args.isEmpty else { invalid("Missing value for \(flag)") }
    let value = args.removeFirst()
    switch flag {
    case "--scenario":
        guard ["baseline", "hidden", "shown", "magnification", "left", "right", "permission-denied", "permission-revoked"].contains(value) else { invalid("Unknown scenario") }
        options.scenario = value
    case "--duration":
        guard let n = Double(value), n.isFinite, (0.1...120).contains(n) else { invalid("Duration must be 0.1...120 seconds") }
        options.duration = n
    case "--interval":
        guard let n = Double(value), n.isFinite, (0.05...5).contains(n) else { invalid("Interval must be 0.05...5 seconds") }
        options.interval = n
    default: invalid("Unknown option: \(flag)")
    }
}
func emit(_ value: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    } catch { FileHandle.standardError.write(Data("JSON serialization failed: \(error)\n".utf8)); exit(1) }
}
func rect(_ r: CGRect) -> [String: Double] {
    ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
}
func attr(_ element: AXUIElement, _ key: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, key as CFString, &value)
    return (error, value)
}
func axRect(_ element: AXUIElement) -> CGRect? {
    let (_, p) = attr(element, kAXPositionAttribute)
    let (_, s) = attr(element, kAXSizeAttribute)
    guard let p, let s, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { return nil }
    let r = CGRect(origin: point, size: size)
    guard [r.minX,r.minY,r.width,r.height].allSatisfy({ $0.isFinite }), r.width > 1, r.height > 1 else { return nil }
    return r
}
final class EdgeView: NSView {
    var orientation = "bottom"
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemOrange.setStroke()
        let path = NSBezierPath(); path.lineWidth = 3; path.setLineDash([6, 4], count: 2, phase: 0)
        if orientation == "bottom" { path.move(to: NSPoint(x: 0, y: bounds.midY)); path.line(to: NSPoint(x: bounds.maxX, y: bounds.midY)) }
        else { path.move(to: NSPoint(x: bounds.midX, y: 0)); path.line(to: NSPoint(x: bounds.midX, y: bounds.maxY)) }
        path.stroke()
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
panel.level = .floating; panel.hidesOnDeactivate = false; panel.ignoresMouseEvents = true
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenNone]
let edgeView = EdgeView(); panel.contentView = edgeView
#if arch(arm64)
let architecture = "arm64"
#else
let architecture = "unsupported_non_arm64"
#endif
let primaryID = CGMainDisplayID()
let primaryBounds = CGDisplayBounds(primaryID)
emit(["type": "environment", "os": ProcessInfo.processInfo.operatingSystemVersionString,
      "architecture": architecture,
      "processID": ProcessInfo.processInfo.processIdentifier, "executable": CommandLine.arguments[0],
      "primaryDisplayID": primaryID, "coordinateSpace": "CoreGraphics global points, top-left origin; AppKit converted only for overlay",
      "screens": NSScreen.screens.map { ["frame": rect($0.frame), "visibleFrameDiagnosticOnly": rect($0.visibleFrame), "scale": $0.backingScaleFactor] as [String: Any] },
      "overlay": options.overlay, "permissionScope": "Current executable/launch host only; never transferred to packaged Electron"])
let started = ProcessInfo.processInfo.systemUptime
var count = 0; var candidateCount = 0
func sample() {
    let dock = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == "com.apple.dock" }
    let trusted = AXIsProcessTrusted()
    let capture = CGPreflightScreenCaptureAccess()
    let prefs = UserDefaults.standard.persistentDomain(forName: "com.apple.dock") ?? [:]
    let orientation = prefs["orientation"] as? String ?? "unknown"
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    let dockWindows = (windows ?? []).filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == dock?.processIdentifier }.map {
        ["bounds": $0[kCGWindowBounds as String] ?? [:], "layer": $0[kCGWindowLayer as String] ?? -1, "alpha": $0[kCGWindowAlpha as String] ?? -1] as [String: Any]
    }
    let sampleDeadline = min(started + options.duration, ProcessInfo.processInfo.systemUptime + 0.5)
    var nodes: [[String: Any]] = []; var candidates: [CGRect] = []; var visited = 0
    var axError: Int32 = -999; var truncated = false
    if let dock {
        let root = AXUIElementCreateApplication(dock.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.05)
        let (error, _) = attr(root, kAXRoleAttribute); axError = error.rawValue
        // Bound both tree depth and node count; keep every observed rectangle diagnostic.
        func walk(_ node: AXUIElement, _ depth: Int) {
            guard visited < 64, depth <= 3, ProcessInfo.processInfo.systemUptime < sampleDeadline else { truncated = true; return }; visited += 1
            let (_, roleValue) = attr(node, kAXRoleAttribute)
            let role = roleValue as? String ?? "unknown"
            if let r = axRect(node) {
                nodes.append(["role": role, "bounds": rect(r), "depth": depth])
                let intersection = r.intersection(primaryBounds)
                let notScreen = r.width < primaryBounds.width * 0.95 || r.height < primaryBounds.height * 0.95
                let touches: Bool
                switch orientation {
                case "bottom": touches = abs(r.maxY - primaryBounds.maxY) < 8 && r.height < primaryBounds.height * 0.4
                case "left": touches = abs(r.minX - primaryBounds.minX) < 8 && r.width < primaryBounds.width * 0.4
                case "right": touches = abs(r.maxX - primaryBounds.maxX) < 8 && r.width < primaryBounds.width * 0.4
                default: touches = false
                }
                if role == "AXList", notScreen, touches, !intersection.isNull { candidates.append(r) }
            }
            if depth < 3 {
                let (_, childValue) = attr(node, kAXChildrenAttribute)
                for child in (childValue as? [AXUIElement] ?? []).prefix(64) { walk(child, depth + 1) }
            }
        }
        if trusted && error == .success { walk(root, 0) }
    }
    let candidate = candidates.count == 1 ? candidates.first : nil
    panel.orderOut(nil)
    if let r = candidate, options.overlay {
        // AppKit Y origin is the bottom of the primary display, regardless of secondary screens.
        let primaryHeight = NSScreen.screens.first?.frame.height ?? primaryBounds.height
        let line: NSRect
        if orientation == "bottom" { line = NSRect(x: r.minX, y: primaryHeight - r.minY - 3, width: r.width, height: 6) }
        else { line = NSRect(x: (orientation == "left" ? r.maxX : r.minX) - 3, y: primaryHeight - r.maxY, width: 6, height: r.height) }
        edgeView.orientation = orientation; panel.setFrame(line, display: true); edgeView.needsDisplay = true; panel.orderFrontRegardless()
    }
    if candidate != nil { candidateCount += 1 }
    let reason = !trusted ? "accessibility_unavailable" : (axError != 0 ? "accessibility_query_failed" : (candidate == nil ? "no_unique_visible_AXList_candidate" : "candidate_requires_visual_validation"))
    emit(["type": "sample", "index": count, "elapsed": ProcessInfo.processInfo.systemUptime - started,
          "timestamp": ISO8601DateFormatter().string(from: Date()), "scenario": options.scenario,
          "scenarioIsOperatorLabelOnly": true, "accessibilityTrusted": trusted, "screenCapturePermission": capture,
          "dockProcessFound": dock != nil, "dockAXError": axError, "axNodes": nodes, "axTreeTruncated": truncated,
          "windowListAvailable": windows != nil, "dockWindowsDiagnosticOnly": dockWindows,
          "dockConfigDiagnosticOnly": ["orientation": orientation, "autohide": prefs["autohide"] ?? NSNull(), "magnification": prefs["magnification"] ?? NSNull(), "tilesize": prefs["tilesize"] ?? NSNull()],
          "candidateBounds": candidate.map { rect($0) } as Any? ?? NSNull(), "candidateCount": candidates.count,
          "supportEdge": NSNull(), "geometryStatus": reason,
          "limit": "AXList and CGWindow bounds are not a proven pixel contour. Hidden state, magnification and icon tops require visual comparison. No climb authorized."])
    count += 1
}
sample()
while ProcessInfo.processInfo.systemUptime - started < options.duration {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: min(options.interval, max(0, options.duration - (ProcessInfo.processInfo.systemUptime - started)))))
    if ProcessInfo.processInfo.systemUptime - started < options.duration { sample() }
}
panel.orderOut(nil)
emit(["type": "summary", "sampleCount": count, "samplesWithCandidate": candidateCount,
      "productFeasibility": "unverified", "elapsed": ProcessInfo.processInfo.systemUptime - started,
      "outcome": candidateCount == 0 ? "negative_no_usable_edge_observed" : "candidate_only_needs_visual_validation",
      "limit": "No Dock climb implemented. Repeat in signed packaged Electron host and supported system/display matrix."])
