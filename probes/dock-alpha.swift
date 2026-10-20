import AppKit
import CoreGraphics
import Foundation
import ImageIO

// Inspects an existing local PNG only. No capture, upload or permission APIs.
func fail(_ message: String, _ code: Int32 = 64) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(code)
}
var path: String?
var threshold: Int?
var orientation = "bottom"
var overlay = false
var largestComponent = false
var duration = 5.0
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let arg = args.removeFirst()
    if arg == "--help" {
        print("dock-alpha LOCAL.png --threshold 1..255 [--orientation bottom|left|right] [--overlay] [--largest-component] [--duration 0.1..30]")
        print("Reads existing PNG alpha only. Cyan raster outline is a diagnostic, never verified support geometry.")
        exit(0)
    }
    if arg == "--largest-component" { largestComponent = true; continue }
    if arg == "--overlay" { overlay = true; continue }
    if !arg.hasPrefix("--") {
        guard path == nil else { fail("Only one local PNG path is allowed") }; path = arg; continue
    }
    guard !args.isEmpty else { fail("Missing value for \(arg)") }
    let value = args.removeFirst()
    switch arg {
    case "--threshold":
        guard let n = Int(value), (1...255).contains(n) else { fail("Threshold must be 1...255") }; threshold = n
    case "--orientation":
        guard ["bottom", "left", "right"].contains(value) else { fail("Unknown orientation") }; orientation = value
    case "--duration":
        guard let n = Double(value), n.isFinite, (0.1...30).contains(n) else { fail("Duration must be 0.1...30 seconds") }; duration = n
    default: fail("Unknown option: \(arg)")
    }
}
guard let path, let threshold else { fail("Provide a local PNG path and explicit --threshold") }
let url = URL(fileURLWithPath: path).standardizedFileURL
guard FileManager.default.isReadableFile(atPath: url.path),
      let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { fail("Cannot read local image", 66) }
guard CGImageSourceGetType(source) as String? == "public.png",
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= 16384, height <= 16384, width * height <= 50_000_000,
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("Expected PNG with at most 50 million pixels and 16384 pixels per axis", 65) }
let hasAlpha = ![CGImageAlphaInfo.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo)
guard hasAlpha else { fail("PNG has no alpha channel; an opaque image cannot isolate Dock pixels", 65) }
var pixels = [UInt8](repeating: 0, count: width * height * 4)
let rendered = pixels.withUnsafeMutableBytes { bytes -> Bool in
    guard let context = CGContext(data: bytes.baseAddress, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
}
guard rendered else { fail("Cannot decode PNG into bounded RGBA buffer", 65) }
var selected = 0; var nonzero = 0
var minX = width; var minY = height; var maxX = -1; var maxY = -1
var inward = [Int](repeating: -1, count: orientation == "bottom" ? width : height)
for y in 0..<height {
    for x in 0..<width {
        let alpha = Int(pixels[(y * width + x) * 4 + 3])
        if alpha > 0 { nonzero += 1 }
        guard alpha >= threshold else { continue }
        selected += 1
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        switch orientation {
        case "bottom": if inward[x] == -1 { inward[x] = y }
        case "left": inward[y] = x
        default: if inward[y] == -1 { inward[y] = x }
        }
    }
}
let thresholdPixelCount = selected
var componentCount: Int?
if largestComponent {
    // Reuse decoded alpha as a visited bitmap; never modify or save the source file.
    // Stack entries fit Int32 because the decoder permits at most 50 million pixels.
    var stack: [Int32] = []
    var componentInward = [Int](repeating: -1, count: inward.count)
    var touchedAxes: [Int] = []
    var components = 0
    selected = 0
    for seed in 0..<(width * height) {
        guard Int(pixels[seed * 4 + 3]) >= threshold else { continue }
        components += 1
        var size = 0
        var cMinX = width; var cMinY = height; var cMaxX = -1; var cMaxY = -1
        func enqueue(_ index: Int) {
            guard Int(pixels[index * 4 + 3]) >= threshold else { return }
            pixels[index * 4 + 3] = 0
            stack.append(Int32(index))
        }
        enqueue(seed)
        while let stored = stack.popLast() {
            let index = Int(stored); let x = index % width; let y = index / width
            size += 1
            cMinX = min(cMinX, x); cMaxX = max(cMaxX, x); cMinY = min(cMinY, y); cMaxY = max(cMaxY, y)
            let axis = orientation == "bottom" ? x : y
            let value = orientation == "bottom" ? y : x
            if componentInward[axis] == -1 {
                componentInward[axis] = value; touchedAxes.append(axis)
            } else if orientation == "left" { componentInward[axis] = max(componentInward[axis], value) }
            else { componentInward[axis] = min(componentInward[axis], value) }
            if x > 0 { enqueue(index - 1) }
            if x + 1 < width { enqueue(index + 1) }
            if y > 0 { enqueue(index - width) }
            if y + 1 < height { enqueue(index + width) }
        }
        // Row-major seed order breaks equal-size ties at the topmost, then leftmost seed.
        if size > selected {
            selected = size; inward = componentInward
            minX = cMinX; maxX = cMaxX; minY = cMinY; maxY = cMaxY
        }
        for axis in touchedAxes { componentInward[axis] = -1 }
        touchedAxes.removeAll(keepingCapacity: true)
    }
    componentCount = components
}
let contour: [[String: Int]] = inward.enumerated().compactMap { index, value in
    guard value >= 0 else { return nil }
    return orientation == "bottom" ? ["x": index, "y": value] : ["x": value, "y": index]
}
let bounds: Any = selected == 0 ? NSNull() : ["x": minX, "y": minY, "width": maxX - minX + 1, "height": maxY - minY + 1]
final class RasterOutline: NSView {
    var points: [[String: Int]] = []
    var orientation = "bottom"
    var xScale = 1.0; var yScale = 1.0
    override func draw(_ dirtyRect: NSRect) {
        NSColor.cyan.setStroke()
        let path = NSBezierPath(); path.lineWidth = 2
        for point in points {
            guard let x = point["x"], let y = point["y"] else { continue }
            if orientation == "bottom" {
                let top = bounds.height - Double(y) / yScale
                path.move(to: NSPoint(x: Double(x) / xScale, y: top))
                path.line(to: NSPoint(x: Double(x + 1) / xScale, y: top))
            } else {
                // Left uses the outside boundary of the rightmost selected pixel.
                let edge = Double(x + (orientation == "left" ? 1 : 0)) / xScale
                path.move(to: NSPoint(x: edge, y: bounds.height - Double(y) / yScale))
                path.line(to: NSPoint(x: edge, y: bounds.height - Double(y + 1) / yScale))
            }
        }
        path.stroke()
    }
}
var overlayStatus = "not_requested"
var displayPoints: Any = NSNull()
var panel: NSPanel?
if overlay {
    let app = NSApplication.shared; app.setActivationPolicy(.accessory)
    let display = CGMainDisplayID()
    if let screen = NSScreen.screens.first(where: {
        ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display
    }), display != 0 {
        if width == CGDisplayPixelsWide(display), height == CGDisplayPixelsHigh(display) {
            let xScale = Double(width) / screen.frame.width
            let yScale = Double(height) / screen.frame.height
            displayPoints = ["displayID": display, "width": screen.frame.width, "height": screen.frame.height,
                             "sourcePixelsPerPointX": xScale, "sourcePixelsPerPointY": yScale,
                             "coordinateSpace": "Primary-display local points, top-left origin for source mapping; canvas converts to AppKit bottom-left",
                             "mappingAssumption": "Input is an uncropped full-primary-display capture; equal dimensions alone do not prove provenance"] as [String: Any]
            let canvas = RasterOutline(); canvas.points = contour; canvas.orientation = orientation
            canvas.xScale = xScale; canvas.yScale = yScale
            let window = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = false
            window.level = .floating; window.hidesOnDeactivate = false; window.ignoresMouseEvents = true
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenNone]; window.contentView = canvas
            window.orderFrontRegardless(); panel = window
            overlayStatus = selected == 0 ? "empty_contour" : "shown_diagnostic_only"
        } else { overlayStatus = "source_dimensions_do_not_match_primary_display" }
    } else { overlayStatus = "desktop_unavailable" }
}
let result: [String: Any] = [
    "type": "dock_alpha_diagnostic", "sourceLocalPath": url.path,
    "sourcePixels": ["width": width, "height": height, "coordinateSpace": "Image pixels, top-left origin"],
    "alphaThreshold": threshold, "thresholdComparison": "alpha >= threshold, integer range 0...255",
    "selectedPixelCount": selected, "thresholdPixelCount": thresholdPixelCount, "nonzeroAlphaPixelCount": nonzero,
    "selectionMode": largestComponent ? "largest_4_connected_alpha_component" : "all_threshold_alpha",
    "componentCount": componentCount as Any? ?? NSNull(),
    "componentTieBreak": "First row-major seed: topmost, then leftmost pixel; ties retain first component", "boundsPixels": bounds,
    "orientation": orientation, "inwardContourPixels": contour, "displayPoints": displayPoints,
    "overlayStatus": overlayStatus, "supportEdge": NSNull(), "productFeasibility": "unverified",
    "limit": "Existing raster alpha diagnostic only. Capture provenance, shadows, tooltips, stale frames and occlusion require validation. Largest-component segmentation can omit detached icons, badges or menus and is not a product geometry rule. No live geometry route or product support edge established."
]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
if panel != nil { RunLoop.current.run(until: Date(timeIntervalSinceNow: duration)); panel?.orderOut(nil) }
