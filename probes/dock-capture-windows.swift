import CoreGraphics
import Foundation
import ScreenCaptureKit

// Metadata lookup only; never starts a stream, requests access, or captures pixels.
@main struct DockCaptureWindows {
    static func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(1) }
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
    static func main() async {
        guard CGPreflightScreenCaptureAccess() else {
            emit(["status": "screen_capture_permission_unavailable", "windows": [], "limit": "No shareable-content query attempted; no permission request made."])
            exit(2)
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            let windows: [[String: Any]] = content.windows.filter {
                $0.owningApplication?.bundleIdentifier == "com.apple.dock"
            }.map {
                ["windowID": $0.windowID,
                 "frame": ["x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height],
                 "isOnScreen": $0.isOnScreen, "layer": $0.windowLayer]
            }
            emit(["status": "metadata_only", "windows": windows,
                  "coordinateSpace": "ScreenCaptureKit window frame in screen points; frame alone is not Dock visible geometry",
                  "limit": "IDs are session-specific. Only com.apple.dock windows returned. No pixels acquired or uploaded."])
        } catch {
            emit(["status": "shareable_content_unavailable", "windows": [], "limit": "Existing grant did not allow metadata lookup; no capture or permission request attempted."])
            exit(2)
        }
    }
}
