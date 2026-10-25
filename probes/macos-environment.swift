import AppKit
import ApplicationServices
import Foundation

// Read-only probe: never prompts for permissions or modifies Dock preferences.
let app = NSApplication.shared
func rect(_ value: NSRect) -> [String: Double] {
    ["x": value.origin.x, "y": value.origin.y,
     "width": value.width, "height": value.height]
}
let screens = NSScreen.screens.map { screen -> [String: Any] in
    ["frame": rect(screen.frame), "visibleFrame": rect(screen.visibleFrame),
     "scale": screen.backingScaleFactor,
     "displayID": (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? -1]
}
let dock = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == "com.apple.dock" }
let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
let dockWindows = (windowInfo ?? []).filter {
    ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == dock?.processIdentifier
}.map { info -> [String: Any] in
    ["bounds": info[kCGWindowBounds as String] ?? [:],
     "layer": info[kCGWindowLayer as String] ?? -1,
     "alpha": info[kCGWindowAlpha as String] ?? -1]
}
let allInfo = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]]
let allDockWindows = (allInfo ?? []).filter {
    guard let dock else { return false }
    return ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == dock.processIdentifier
}.map { info -> [String: Any] in
    ["bounds": info[kCGWindowBounds as String] ?? [:],
     "layer": info[kCGWindowLayer as String] ?? -1,
     "onScreen": info[kCGWindowIsOnscreen as String] ?? false]
}
let dockPrefs = UserDefaults.standard.persistentDomain(forName: "com.apple.dock") ?? [:]
let dockConfig = ["autohide", "orientation", "tilesize"].reduce(into: [String: Any]()) { result, key in
    if let value = dockPrefs[key] { result[key] = value }
}
var dockAXRole: CFTypeRef?
let dockAXError = dock.map { AXUIElementCopyAttributeValue(AXUIElementCreateApplication($0.processIdentifier), kAXRoleAttribute as CFString, &dockAXRole).rawValue }
let probeBundleID = CommandLine.arguments.dropFirst().first ?? "local.corgi.windowprobe"
let probePID = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == probeBundleID }?.processIdentifier
let probeWindows = (windowInfo ?? []).filter {
    guard let probePID else { return false }
    return ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == probePID
}.map { info -> [String: Any] in
    ["bounds": info[kCGWindowBounds as String] ?? [:], "layer": info[kCGWindowLayer as String] ?? -1,
     "id": info[kCGWindowNumber as String] ?? -1]
}
let panel = NSPanel(contentRect: NSRect(x: 100, y: 100, width: 160, height: 160),
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.isOpaque = false
panel.backgroundColor = .clear
panel.hasShadow = false
panel.level = .floating
panel.hidesOnDeactivate = false
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenNone]
panel.ignoresMouseEvents = true
let ignored = panel.ignoresMouseEvents
panel.ignoresMouseEvents = false
let accepted = !panel.ignoresMouseEvents
let result: [String: Any] = [
    "os": ProcessInfo.processInfo.operatingSystemVersionString,
    "screens": screens, "dockProcessFound": dock != nil,
    "onScreenWindowListAvailable": windowInfo != nil, "dockWindows": dockWindows,
    "dockAllWindows": allDockWindows, "dockConfig": dockConfig, "dockAXError": dockAXError ?? -999,
    "probeOnScreenWindows": probeWindows,
    "probeBundleID": probeBundleID,
    "accessibilityTrusted": AXIsProcessTrusted(),
    "screenCapturePermission": CGPreflightScreenCaptureAccess(),
    "panelPropertyRoundtrip": ["transparent": !panel.isOpaque,
        "floating": panel.level == .floating, "nonactivating": panel.styleMask.contains(.nonactivatingPanel),
        "ignoreMouseTrue": ignored, "ignoreMouseFalse": accepted],
    "limit": "Property roundtrips do not prove on-screen behavior, per-pixel passthrough, or full-screen transitions."
]
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
print(String(decoding: data, as: UTF8.self))
