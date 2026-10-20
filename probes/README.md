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
- **Pixels via public capture APIs:** an alternative research direction with screen-recording permission and image segmentation/occlusion/scale costs. The separate alpha and live probes below investigate this route; native live capture and standalone-app authorization evidence is in `results/issue-14/live/README.md`. This does not validate a product support contour or final Electron bridge. It cannot be assumed acceptable simply because the development host already has a grant.
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

## Bounded live ScreenCaptureKit experiment

`dock-live.swift` tests a public `SCStream` with a `desktopIndependentWindow` filter. It accepts an existing screen-recording grant only: the preflight check runs before shareable-content lookup, and a missing grant produces `permission_unavailable`, no stream configuration and exit 2. It never invokes a permission-request API, modifies preferences, saves image frames, captures audio or uploads anything. This is a standalone native experiment, not the final Electron adapter.

Build **optimized** for representative alpha-processing measurements:

```sh
swiftc -O -target arm64-apple-macos15.0 -parse-as-library -module-cache-path /tmp/mosey-dock-probe/module-cache probes/dock-live.swift -o /tmp/mosey-dock-probe/dock-live
python3 probes/test-dock-live.py /tmp/mosey-dock-probe/dock-live
/tmp/mosey-dock-probe/dock-live --duration 15 --interval 0.1 --scenario bottom-shown --output /tmp/mosey-dock-probe/live-bottom-new.jsonl
/tmp/mosey-dock-probe/dock-live --duration 15 --interval 0.1 --scenario magnification --overlay --max-frame-age 1 --output /tmp/mosey-dock-probe/live-magnification-new.jsonl
```

Output files must be new absolute local paths; existing files are never overwritten. Without `--output`, CLI records go to stdout. `buildMode: optimized_-O` records the documented build convention; do not compile without `-O` and then compare the results as optimized. macOS 15 is this experimental binary's API/compile floor, not a product support claim; actual systems still need testing.

The probe enumerates only Dock metadata into the log and selects the unique layer-20 Dock host matching the primary display frame, including offscreen hosts so hidden startup can be observed. When several hosts share that mapping, it selects only a unique on-screen host to disambiguate capture identity; if none or several are on-screen, it refuses. A single offscreen host remains eligible for hidden-start diagnostics. `--window-id ID` selects an explicitly observed ID only if it still belongs to the Dock, and mapping checks remain mandatory. Process presence, host frame and `isOnScreen` are selection diagnostics, never visible geometry. It configures BGRA, SDR, clear background, `shouldBeOpaque=false`, no cursor/audio, queue depth 3, preserved aspect ratio, no offscreen unclipping, and ignored single-window shadows. Independent-window capture itself still needs proof under each real scenario.

Every processed complete frame reports both raw threshold alpha and the largest 4-connected component (same algorithm/tie policy as the offline inspector), pixel bounds, counts and inward-contour summaries/hashes. `--orientation bottom|left|right` chooses topmost-per-column or inward-facing-per-row summaries. A complete frame with truly zero alpha reports `actualAlphaZero: true`; missing/blank/incomplete samples do **not** imply an empty Dock. Fully selected/opaque surfaces are rejected as unreliable isolation. Tooltip exclusion via the largest component is experimental and can omit disconnected visible content.

The capture callback reads metadata and immediately suppresses any prior candidate whenever a newer complete frame arrives. A separate serial worker analyzes one frame; a single replaceable slot retains the newest complete frame while that worker is busy. Replacing an older pending frame is counted, and the worker drains the latest slot even if the stream then becomes idle. A superseded in-flight result cannot become current. There is no local interval gate: ScreenCaptureKit already receives the requested minimum frame interval, and a second throttle could permanently discard the final settling frame. Logs expose pending replacements, superseded work, actual alpha analyses and accepted frames; the legacy `intervalSkipped` field is always zero. Upstream drops remain unknown. A worker can finish its log write while one newest sample waits; no pixel history accumulates.

`sourceDisplayMachTicks` is the WindowServer display timestamp from `SCStreamFrameInfo.displayTime`, not wall-clock nanoseconds. The log records raw receive/start/end mach ticks and timebase numerator/denominator. `callbackAgeFromDisplaySeconds` measures callback arrival relative to that source display time; `queueWaitSeconds` measures worker scheduling wait; `processingSeconds` covers the alpha-analysis path before metadata formatting/JSON writing; `sourceAgeAtProcessingEndSeconds` measures source age after that work. None of these is mouse-input latency. Requested minimum frame interval is not achieved throughput; use actual counts/times. No product latency pass threshold has been agreed.

Only `.complete` frames with valid BGRA buffers, finite usable source timing and matching current display mapping become fresh raster diagnostics. Status codes are SDK values: complete 0, idle 1, blank 2, suspended 3, started 4, stopped 5; unknown/missing is -1. `lastFrameStatusCode`, `frameStatusCounts`, `lastObservedStatus` and `invalidationReason` preserve incomplete transitions. Idle means no new frame and never refreshes the prior complete frame's timestamp. Source age is reported separately from callback age. `--max-frame-age` remains the **admission** cutoff for complete frames (default 1 second); old/rejected complete frames cannot establish a candidate. Without `--idle-current`, source age also limits continued currentness. Opting into `--idle-current` permits the latest fully processed, accepted contour to remain `current_via_idle_heartbeat` while SCK reports fresh idle callbacks, even when its genuine source age exceeds that cutoff. This is explicitly diagnostic currentness based on an unchanged-stream indication, not fresh pixels or verified product geometry. `lastAcceptedSourceDisplayMachTicks` and source age stay genuine. `--callback-timeout` (default 1 second) independently bounds callback silence; silence clears the retained candidate and invalidates even sole in-flight work once per callback gap, and idle alone cannot revive pre-gap work afterward. The `callbackSilenceInvalidations` counter records those gaps. New complete/pending/rejected frames suppress old contours; blank/suspended/stopped/unknown statuses, stream errors, permission loss and display/mapping changes clear them. These are experimental policy settings, not product latency budgets; nothing substitutes a work area. Stream errors, permission loss or changed primary display configuration stop the run; an independent watchdog is armed before AppKit initialization or the first log write and hard-exits at requested duration plus 10 seconds. It does not log or wait for cleanup/locks; a full stdout pipe therefore cannot block the deadline. A hard exit can omit a final summary; exit status 124 is the authoritative timeout signal. The external CLI regression pre-fills a real stdout pipe and leaves it unread to check this boundary.

Optional cyan `--overlay` uses only the latest accepted largest-component inward contour allowed by the explicitly selected diagnostic currentness policy on a nonactivating input-ignoring panel. Mapping requires a full-primary host/filter, unchanged primary display ID/frame/backing scale, actual buffer size equal to primary point size × backing scale, frame `scaleFactor` equal to that scale, `contentScale=1`, and surface `contentRect` origin zero with full-primary point size. Otherwise it refuses to draw. It logs actual frame content/scale metadata; no coordinate guess or fixed edge is introduced. Stale/empty results remove the line. Even accepted raster diagnostics always retain `supportEdge: null` and unverified product feasibility.

### Separate application identity

Build a new local ad-hoc-signed status application:

```sh
sh probes/build-dock-live-app.sh /tmp/MoseyDockLiveProbe.app
```

The script accepts an absolute new `.app` destination and refuses replacement to avoid silently changing an identity already granted permission. It compiles the same source with `-O`, embeds `NSScreenCaptureUsageDescription`, signs/verifies it and writes adjacent `MoseyDockLiveProbe-signing.txt` with identity details. Keep the app path and binary stable throughout a permission experiment. Ad-hoc signing has no developer TeamIdentifier and does not establish final distribution/hardened-runtime/notarization behavior.

Launch that concrete application through Finder or the desktop app tool so LaunchServices starts its **native** executable. Its bundle ID is `local.mosey.dockliveprobe.experimental`; no shell wrapper launches a child capture binary. The executable detects `.app` context and defaults to a status window, 120-second bounded observation and a unique local temporary JSONL path shown in that window. `--app-status` enables the same UI explicitly; `--output` can specify a new absolute log path. A synchronous native entry starts `NSApplication.run()`; its launch delegate creates the status UI and starts the asynchronous capture task after `applicationDidFinishLaunching`. CLI without GUI stays dispatch-driven. The window shows blocked/capturing/stopped state and Quit, and never opens System Settings or requests permission. A missing grant stays blocked until quit/timeout; if the user independently grants access, relaunch the same unchanged app. A CLI invocation under the development host and a LaunchServices app invocation are distinct permission experiments. Logs record bundle/executable paths, bundle ID, PID and parent PID; neither launch proves the final packaged Electron app has a grant.

The parent operator should compare hidden startup, show/hide transitions, magnification/tooltips, side positions, stale/error states and permission denial/revocation in both relevant identities, with system/display/CPU/memory evidence. No screenshots are needed for the live probe; if separately authorized visual evidence is collected, keep it local. A successful native live route is still a candidate until final Electron packaging, permission UX, latency/resource budgets and visible contour reliability are resolved.

### Verify newest-frame and idle-current behavior on the real desktop

The current source/CLI scheduling and opt-in idle-current policy are newer than the already frozen application with CDHash `31649c91cdd82f33784de8b7157f4f451e894aab`. That app was not rebuilt or relocated; its existing permission and runtime evidence do not validate these newer changes.

Run a new bounded CLI observation, then independently note elapsed times of a stable shown interval and the subsequent actual hidden interval:

```sh
/tmp/mosey-dock-probe/dock-live --duration 30 --interval 0.1 --orientation left --idle-current --callback-timeout 1 --max-frame-age 1 --overlay --output /tmp/mosey-dock-probe/live-left-latest-new.jsonl
```

During the run, the operator reveals the real side Dock, waits for it to settle, leaves it unchanged through more than one second of idle callbacks, captures an independently authorized isolated PNG locally if available, then hides it and waits for the non-idle invalidation. Do not infer the phase times from desired scenario labels. Analyze the independent PNG with the same orientation/threshold and compare its complete contour to the final live contour; bounds alone can miss a changed edge. The local phase checker takes an independently computed contour hash and operator-observed elapsed markers:

```sh
python3 probes/check-dock-live-phase.py /tmp/mosey-dock-probe/live-left-latest-new.jsonl --after SHOWN_STABLE_START --before HIDE_START --expected-hash INDEPENDENT_CONTOUR_HASH --expect-idle-current --hidden-after HIDDEN_OBSERVED_TIME
```

It requires the last accepted nonempty shown-phase contour to match the independent oracle, explicit idle-current heartbeats retaining that frame's original source timestamp with source age beyond the admission cutoff, fresh callback age and no newer pending complete frame, followed by a clearing non-idle status in the observed hidden phase. Repeat for right and bottom/magnification; compare exact provenance/threshold/coordinate conventions before interpreting a hash mismatch. The existing CLI smoke tests exercise the real process protocol, argument handling, file preservation and hard deadline; they cannot establish newest-frame/idle behavior when the host lacks capture permission. Before-fix real left and app-idle logs demonstrate the regression. Actual desktop phase checks, rather than argument smoke tests, establish whether a given new run meets the conditions. `supportEdge` remains null throughout.
