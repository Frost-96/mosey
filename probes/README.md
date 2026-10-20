# macOS Dock geometry experiment (#14)

This standalone native experiment extends `macos-environment.swift` diagnostics; it does not need the product application, Electron, npm or a daemon. It uses only AppKit, ApplicationServices and Foundation. The baseline remains available as `macos-environment.swift`; it reports environment/property roundtrips, not verified desktop behavior.

Build on the Apple Silicon Mac under test (Xcode command-line tools required):

```sh
mkdir -p /tmp/mosey-dock-probe
swiftc -module-cache-path /tmp/mosey-dock-probe/module-cache probes/dock-geometry.swift -o /tmp/mosey-dock-probe/dock-geometry
python3 probes/test-dock-probe.py /tmp/mosey-dock-probe/dock-geometry
/tmp/mosey-dock-probe/dock-geometry --scenario baseline --duration 10 > /tmp/mosey-dock-probe/baseline.jsonl
```

The external CLI smoke checks also verify `--item-overlay` is accepted while `--no-overlay` disables both overlay types, and all support geometry stays unverified. They launch the real process and validate its public output, termination, invalid arguments and fail-closed result. They do **not** verify actual Dock edges or human-visible overlay alignment. `--help` documents bounded sampling: 0.1–120 seconds, 0.05–5 second interval; the last synchronous native query can overrun the deadline slightly. Every AX attribute query sets a 50 ms messaging timeout on its own element (child objects do not inherit root timeouts); the walk has a 64-node/3-level walk limit and a 0.5 second per-sample traversal budget. No screen images are captured or saved. JSONL is emitted to stdout, so choose a fresh local destination for each bounded run.

## Run the real scenarios

Use a normal desktop, hold the display configuration steady, and record the primary display's resolution/scaling, OS/hardware, executable path and launch host. Environment records include OS, process architecture, display frames/scales, permission checks and PID. `visibleFrame` is diagnostic only. Set up each scenario **yourself** using existing system controls; the probe never changes Dock settings or asks for permission.

```sh
/tmp/mosey-dock-probe/dock-geometry --scenario shown --duration 15 > /tmp/mosey-dock-probe/shown.jsonl
/tmp/mosey-dock-probe/dock-geometry --scenario hidden --duration 15 > /tmp/mosey-dock-probe/hidden.jsonl
/tmp/mosey-dock-probe/dock-geometry --scenario magnification --duration 15 > /tmp/mosey-dock-probe/magnification.jsonl
/tmp/mosey-dock-probe/dock-geometry --scenario left --duration 15 > /tmp/mosey-dock-probe/left.jsonl
/tmp/mosey-dock-probe/dock-geometry --scenario right --duration 15 > /tmp/mosey-dock-probe/right.jsonl
```

- Bottom shown: reveal the real Dock, observe the entire width, then move away and back. Compare the amber dashed candidate line with the visible top edge. Record whether the Dock actually remains visible throughout each sample range.
- Bottom hidden: move away until the Dock hides, reveal it, then hide again. Record approximate elapsed times of visible transitions so they can be matched to samples. A stale or offscreen AX candidate is a failure, not a hidden-state detector.
- Magnification: with magnification already enabled by the operator, sweep across icons and the gaps at different speeds. Compare the candidate against actual changing icon tops and the Dock background separately. A rectangle matching the background is insufficient proof of the visible collision contour.
- Left/right: after the operator has selected each orientation, reveal/hide the Dock and compare its inward-facing edge. Side geometry is for avoidance only, never climbing.
- Permission unavailable/denied/revoked: run with `--scenario permission-denied` from a launch host already lacking AX permission, or `permission-revoked` after the operator independently revokes an existing grant. Repeat after relaunch as appropriate. Do not change permissions merely to make the probe pass. Record what the system actually reports; these labels cannot distinguish never-granted from denied. No prompt is generated. The current process/host's grant does not establish a packaged Electron grant.

Scenario names are operator annotations, **not assertions that those states occurred**. Record the matching timestamps, observed Dock state, overlay alignment and any uncertainty in the evidence notes. Compare visually with local screenshots or recordings made through already-authorized tools when available; do not grant a permission just to generate evidence. If unavailable, record that evidence gap. Restore any settings you changed yourself when finished.

## Optional per-item diagnostic overlay

The default remains the amber AXList candidate line. For a separate magnification investigation, opt into cyan per-item segments:

```sh
/tmp/mosey-dock-probe/dock-geometry --scenario magnification --duration 15 --item-overlay > /tmp/mosey-dock-probe/magnification-items.jsonl
```

Each cyan segment follows the inward-facing edge of an observed, fully display-contained `AXDockItem` rectangle: top/minY for bottom Dock, right/maxX for left Dock, left/minX for right Dock. The transparent full-primary-display canvas is a nonactivating panel that ignores mouse input. Both canvases are removed at completion. `--no-overlay` suppresses both amber and cyan regardless of flag order. No screenshots are acquired by this option; any authorized visual comparison stays local.

The item canvas only appears while AX is trusted, traversal is complete, and the existing unique root-list candidate is available. Loss of those conditions removes the segments on the next sample. Item rectangles remain recorded in `axNodes`; the flag adds visual diagnostics, not a product collision path. Compare each segment against the actual icon silhouette/background during magnification: AX item rectangles can include padding and are not proven visible support contours. `supportEdge` remains null even if cyan segments track magnification.

## Reading the evidence

Each sample reports read-only `AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess`, Dock PID availability, AX query error, bounded AX role/rect observations, CG on-screen Dock windows and preference diagnostics. Permission is rechecked each sample. No AX walk runs when trust is absent, but the root AX error is recorded. The first query can still fail despite an existing trust grant. A `screenCapturePermission` of true belongs to this executable/host; the probe does not use that grant to acquire pixels.

AX and CGWindow geometry in samples uses global CoreGraphics points with top-left origin. Environment `screens` frame/visibleFrame fields explicitly use AppKit global points with bottom-left origin; each includes its display ID for mapping to `primaryDisplayID`. Overlay coordinates are converted to AppKit points using the primary display height. The overlay is nonactivating, ignores mouse input and is removed at normal completion; closing the process also removes it. It intentionally does not draw a screen-wide/work-area substitute.

Only a unique bounded `AXList` fully contained within the primary display and near its configured Dock side can become `candidateBounds`. The candidate-selection heuristic permits a floating inset up to half the list's short-axis size, capped at 5% of the corresponding display axis; list thickness must remain below 40% of that axis. These experimental filters accommodate the observed 10-point bottom inset without inventing a support boundary. They reject the observed hidden AXList beginning at the display's bottom edge and extending offscreen. They do not establish visibility during every animation or at other system settings. An amber dashed line marks its inward-facing edge. Other AX nodes and all CG windows remain diagnostic. A process, preference value, work area or screen-sized Dock window never becomes support geometry. AXList bounds can describe a container/background, lag during animation, omit magnified icon contours, or persist while hidden. Therefore even a candidate leaves `supportEdge: null`, `geometryStatus: candidate_requires_visual_validation`, and `productFeasibility: unverified`. When the desktop can be observed, a missing line with `accessibility_unavailable` or no candidate is reproducible negative evidence, not successful climbing. A missing primary display/screens or unavailable window list yields `geometryStatus: desktop_unavailable`; zero observable desktop samples yield summary `outcome: unavailable_desktop_session`. This means desktop observation is unavailable (for example a sandbox without GUI access), not proof that AX was denied or that Dock geometry is infeasible. Environment `desktopAvailable` reports display availability; sample `desktopObservationAvailable` additionally requires the window list. `desktopSampleCount` distinguishes wholly unavailable from partially observable runs. `axTreeTruncated` reports omitted descendants at the depth/node/time limit or incomplete child queries, and suppresses candidate selection/overlay: an incomplete traversal cannot establish uniqueness. `candidateCount` then means observed candidates only.

When there is no reliable route, preserve this failed/unverified result. Do not silently introduce a fixed boundary or mark Dock climbing complete. The experiment itself implements no pet overlap, climbing or falling behavior.

## Candidate native integration and costs

- **CGWindowListCopyWindowInfo / NSScreen:** public diagnostics available without a third-party bridge. On-screen enumeration may expose the Dock's full-screen host window rather than its visible contour; `visibleFrame` is a general work area. Neither is a verified collision source.
- **Accessibility AXUIElement:** public, permission-gated candidate for semantic Dock bounds. This probe tests bounded polling; it does not establish notification coverage or magnification accuracy. Validate animation, hiding and revocation before committing to it. AX permission UX and a fail-closed product state need explicit decisions if this becomes necessary.
- **Pixels via public capture APIs:** an alternative research direction with screen-recording permission and image segmentation/occlusion/scale costs. This experiment does not implement or validate it. It cannot be assumed acceptable simply because the development host already has a grant.
- **Bridge if evidence supports one:** a small signed Swift helper communicating bounded JSON over stdio is a candidate that avoids a Node native ABI dependency, but adds child-process lifecycle, hardened runtime/signing, packaging placement, error handling and TCC identity testing. An Objective-C++/N-API addon avoids a separate process but adds arm64 Electron ABI/build/rebuild/signing maintenance and must keep native calls off latency-sensitive work. Neither option is selected by this probe. No public plugin or persistent daemon is introduced.

Retest the chosen route within the final packaged/signed Electron application: current host permission, standalone Swift operation and successful property assignments are not product evidence. Record system versions and display configurations separately. A geometry route needs reliable visible state, actual changing support contour, temporal lag and permission-failure evidence before the product can use it.

## Inspect an existing isolated Dock PNG locally

`dock-alpha.swift` is a separate one-shot research tool. It reads an existing local PNG through ImageIO/CoreGraphics, evaluates 8-bit alpha at the explicitly supplied threshold, and emits selected bounds, pixel counts and an inward-facing raster contour. It does not capture pixels, invoke permission APIs, change settings or upload anything. No image files belong in the repository.

The optional `dock-capture-windows.swift` metadata lookup uses ScreenCaptureKit to return only Dock window IDs, frames, on-screen flags and layers. It first checks existing screen-capture authorization; if unavailable it exits 2 before asking for shareable content. It never requests access, starts a capture stream or returns other applications' titles. Existing grants can still fail, and window IDs can change between launches. A screen-sized frame is still not visible Dock geometry.

Build and run locally:

```sh
mkdir -p /tmp/mosey-dock-probe
swiftc -module-cache-path /tmp/mosey-dock-probe/module-cache probes/dock-alpha.swift -o /tmp/mosey-dock-probe/dock-alpha
swiftc -parse-as-library -module-cache-path /tmp/mosey-dock-probe/module-cache probes/dock-capture-windows.swift -o /tmp/mosey-dock-probe/dock-capture-windows
python3 probes/test-dock-alpha.py /tmp/mosey-dock-probe/dock-alpha /tmp/mosey-dock-probe/dock-capture-windows
/tmp/mosey-dock-probe/dock-capture-windows > /tmp/mosey-dock-probe/dock-capture-windows.json
```

Inspect the lookup result locally and select the actual on-screen Dock window ID. Only when the user has authorized a **local native screenshot**, substitute that observed session-specific ID for `WINDOW_ID` below and run the native capture separately:

```sh
screencapture -x -o -l WINDOW_ID /tmp/mosey-dock-probe/dock-window-isolated.png
/tmp/mosey-dock-probe/dock-alpha /tmp/mosey-dock-probe/dock-window-isolated.png --threshold 128 > /tmp/mosey-dock-probe/dock-alpha.json
/tmp/mosey-dock-probe/dock-alpha /tmp/mosey-dock-probe/dock-window-isolated.png --threshold 128 --orientation bottom --overlay --duration 5 > /tmp/mosey-dock-probe/dock-alpha-overlay.json
```

The native screenshot is an operator action, outside both probes. It is not authorization for remote screenshots or uploads. Do not substitute an arbitrary enumerated window, upload the PNG, or copy it into repository evidence. If lookup is unavailable, stop that route rather than requesting permission. For an already available PNG, the alpha inspector works independently of lookup and desktop access.

`sourcePixels`, `boundsPixels` and `inwardContourPixels` use integer image pixels with top-left origin. Alpha selection is `alpha >= threshold`, with an explicit integer threshold 1–255. Bounds include selected pixel cells; a transparent image has null bounds and an empty contour. `bottom` emits the topmost selected pixel per column, `left` the rightmost per row, and `right` the leftmost per row. The left overlay uses the right boundary of each selected pixel cell; other overlays use its top/left boundary. Non-alpha PNGs and oversized images fail explicitly; decoding is bounded to 50 million pixels and 16384 pixels per axis.

`--overlay` draws the cyan raster contour on a nonactivating, input-ignoring primary-display panel for 0.1–30 seconds. It matches the primary `NSScreen` by display ID, and requires PNG dimensions equal to that screen's point frame multiplied by its backing scale; otherwise it reports an unavailable/mismatch status and draws nothing. `CGDisplayPixelsWide/High` can report logical-size dimensions under scaled Retina modes and are included only as diagnostics, never as the raster guard. `mappingDiagnostics` reports source raster dimensions, expected backing raster dimensions, point size and backing scale even when the dimensions mismatch. `displayPoints` reports the source-pixels-per-display-point ratios and local point mapping. Equal dimensions alone do not prove the image is an uncropped primary-display capture: verify its provenance and display configuration yourself. The contour is a static captured frame; it cannot follow subsequent icon motion or show/hide changes.

The CLI smoke tests use temporary independently encoded transparent/asymmetric PNGs and verify public process results, including threshold selection and top-left pixel coordinates. They do not prove the captured image contains only visible Dock pixels. Actual raster alpha can include shadow, background, tooltip or stale/occluded/partial contents, and threshold choice changes the contour. Compare multiple thresholds and real magnification frames locally. All results keep `supportEdge: null` and `productFeasibility: unverified`; a promising isolated capture still needs a public live-capture route, bounded latency, visibility, permission/revocation and final packaged-host validation.

### Optional largest-component experiment

A detached Dock tooltip can become the topmost alpha in an isolated capture. To investigate this failure separately, `--largest-component` keeps only the largest **4-connected** component of pixels meeting the threshold before computing bounds/contour:

```sh
/tmp/mosey-dock-probe/dock-alpha /tmp/mosey-dock-probe/dock-window-isolated.png --threshold 128 --largest-component > /tmp/mosey-dock-probe/dock-alpha-largest.json
```

Default analysis still uses all threshold-selected alpha. With the flag, `selectionMode` becomes `largest_4_connected_alpha_component`; `selectedPixelCount` refers to the retained component, `thresholdPixelCount` counts all raw threshold-selected pixels, and `nonzeroAlphaPixelCount` remains the raw nonzero-alpha count. `componentCount` is populated only when segmentation runs. Equal-sized components deterministically retain the first component encountered by a top-to-bottom, left-to-right seed scan. Diagonally touching pixels are separate components. The source file is never changed.

This can exclude a detached tooltip, but can also discard disconnected icons, badges or menus, or retain a large unrelated/background component. Connectivity depends on alpha threshold, shadow and antialiasing. It is an experimental segmentation rule, **not** a product support-edge rule. Overlay mapping and provenance checks still apply, `supportEdge` remains null, and visible body alignment must be compared locally. Flood-fill work and its temporary stack scale with decoded image size; no real-time latency or packaged live-capture guarantee follows from this offline tool.
