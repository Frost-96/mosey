# macOS Dock geometry experiment (#14)

This standalone native experiment extends `macos-environment.swift` diagnostics; it does not need the product application, Electron, npm or a daemon. It uses only AppKit, ApplicationServices and Foundation. The baseline remains available as `macos-environment.swift`; it reports environment/property roundtrips, not verified desktop behavior.

Build on the Apple Silicon Mac under test (Xcode command-line tools required):

```sh
mkdir -p /tmp/mosey-dock-probe
swiftc -module-cache-path /tmp/mosey-dock-probe/module-cache probes/dock-geometry.swift -o /tmp/mosey-dock-probe/dock-geometry
python3 probes/test-dock-probe.py /tmp/mosey-dock-probe/dock-geometry
/tmp/mosey-dock-probe/dock-geometry --scenario baseline --duration 10 > /tmp/mosey-dock-probe/baseline.jsonl
```

The external CLI smoke checks launch the real process and validate its public output, termination, invalid arguments and fail-closed result. They do **not** verify actual Dock edges or human-visible overlay alignment. `--help` documents bounded sampling: 0.1–120 seconds, 0.05–5 second interval; the last synchronous native query can overrun the deadline slightly. AX has a 50 ms messaging timeout, a 64-node/3-level walk limit and a 0.5 second per-sample traversal budget. No screen images are captured or saved. JSONL is emitted to stdout, so choose a fresh local destination for each bounded run.

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

## Reading the evidence

Each sample reports read-only `AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess`, Dock PID availability, AX query error, bounded AX role/rect observations, CG on-screen Dock windows and preference diagnostics. Permission is rechecked each sample. No AX walk runs when trust is absent, but the root AX error is recorded. The first query can still fail despite an existing trust grant. A `screenCapturePermission` of true belongs to this executable/host; the probe does not use that grant to acquire pixels.

All coordinates in samples are global CoreGraphics points with top-left origin. Overlay coordinates are converted to AppKit points using the primary display height. The overlay is nonactivating, ignores mouse input and is removed at normal completion; closing the process also removes it. It intentionally does not draw a screen-wide/work-area substitute.

Only a unique bounded `AXList` touching the configured primary-display Dock side can become `candidateBounds`. An amber dashed line marks its inward-facing edge. Other AX nodes and all CG windows remain diagnostic. A process, preference value, work area or screen-sized Dock window never becomes support geometry. AXList bounds can describe a container/background, lag during animation, omit magnified icon contours, or persist while hidden. Therefore even a candidate leaves `supportEdge: null`, `geometryStatus: candidate_requires_visual_validation`, and `productFeasibility: unverified`. A missing line with `accessibility_unavailable` or no candidate is reproducible negative evidence, not successful climbing. `axTreeTruncated` limits any conclusion from absent deeper nodes.

When there is no reliable route, preserve this failed/unverified result. Do not silently introduce a fixed boundary or mark Dock climbing complete. The experiment itself implements no pet overlap, climbing or falling behavior.

## Candidate native integration and costs

- **CGWindowListCopyWindowInfo / NSScreen:** public diagnostics available without a third-party bridge. On-screen enumeration may expose the Dock's full-screen host window rather than its visible contour; `visibleFrame` is a general work area. Neither is a verified collision source.
- **Accessibility AXUIElement:** public, permission-gated candidate for semantic Dock bounds. This probe tests bounded polling; it does not establish notification coverage or magnification accuracy. Validate animation, hiding and revocation before committing to it. AX permission UX and a fail-closed product state need explicit decisions if this becomes necessary.
- **Pixels via public capture APIs:** an alternative research direction with screen-recording permission and image segmentation/occlusion/scale costs. This experiment does not implement or validate it. It cannot be assumed acceptable simply because the development host already has a grant.
- **Bridge if evidence supports one:** a small signed Swift helper communicating bounded JSON over stdio is a candidate that avoids a Node native ABI dependency, but adds child-process lifecycle, hardened runtime/signing, packaging placement, error handling and TCC identity testing. An Objective-C++/N-API addon avoids a separate process but adds arm64 Electron ABI/build/rebuild/signing maintenance and must keep native calls off latency-sensitive work. Neither option is selected by this probe. No public plugin or persistent daemon is introduced.

Retest the chosen route within the final packaged/signed Electron application: current host permission, standalone Swift operation and successful property assignments are not product evidence. Record system versions and display configurations separately. A geometry route needs reliable visible state, actual changing support contour, temporal lag and permission-failure evidence before the product can use it.
