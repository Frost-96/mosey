# Issue 9 — three sizes

## Scope and contract

The shared `src/shared/size.ts` geometry defines small/medium/large canvas sides as 180/240/300 desktop DIP. These are implementation tuning values, not previously agreed product dimensions. Every pose anchors its metadata foot to the bottom center of that canvas. Atlas pixels use the metadata pixel ratio; the size multiplier is independent of the display device pixel ratio. Canvas backing pixels use the latter; window bounds, movement, ground and pointer coordinates use DIP.

Main and renderer consume the same geometry. A successful size change keeps the physical bottom-center foot, then clamps the new rectangle to the primary work area when necessary. Falling is expressed relative to the physical foot so a size change does not restart or jump its path. Resizing a captured pet releases its old capture and lets it return naturally; it does not teleport to the ground. Future autonomy, sleep and Dock adapters should use this geometry and the current main-process work-area/foot contract. This ticket does not implement those features.

Size and manual visibility share the version-1 Zod-validated preferences document. Atomic writes retain the previous validated backup. A failed size commit keeps the current size and rebuilds the radio menu. Action, drag, fall, window position and geometry revision are not durable. Startup uses the restored size and current primary-display ground in stable rest.

A monotonically increasing geometry revision accompanies presentation, press and draw reports. Main drops reports from earlier geometry, releases the opaque input region during synchronization, and re-enables hit testing only after a current draw report. This avoids old-sized masks blocking transparent desktop regions. Renderer cancels captured input when the revision changes.

## Automated evidence

The agreed seam is the real Electron application: menu actions, rendered pixels, public desktop window bounds, directed pointer input, relaunches, external preference damage and local log output. No internal behavior-state tests or product test hooks were added.

TDD record:

- RED: development size acceptance failed with `Missing size menu item: Small` before implementation.
- GREEN: menu/window/Canvas/footer geometry passed at 1x after the first implementation.
- Extended interactions initially used Vitest's default poll timeout for an animation lasting longer; increasing the external idle-return observation timeout to match the existing response suite passed without a product change.
- GREEN: development 1x size interactions, body and edge clicks, transparent corner rejection, dragging, catching during return, hidden size persistence and preference recovery passed in 30.62 seconds before adding active-resize acceptance.

Final matrix and commands are recorded below after execution.

## Evidence limits and remaining desktop acceptance

Directed Playwright events and screenshots prove application coordinate handling. They do not prove cross-application OS routing, first physical click after fast cursor entry, native menu tracking, focus behavior, or clicks reaching the application underneath. Those require actual desktop input. The existing 8 ms pointer polling adapter retains its previously documented first-click race; this ticket does not claim that the race is solved.

Forced 1x/2x Chromium scale factors test rendering/coordinate paths on this machine; they do not establish coverage of multiple physical display models, every macOS scaling setting, or other macOS versions. The screenshot proportions preserve the existing character and grounded paws at all three pixel sizes, but actual desktop presence and final dimension tuning require the parent task's real-desktop review. Keep unverified acceptance open instead of describing directed events as physical-input evidence.

Tracked 1x Canvas samples: [small](issue-9-small.png), [medium](issue-9-medium.png), [large](issue-9-large.png). These are rendered-window samples, not full desktop input-routing evidence.
