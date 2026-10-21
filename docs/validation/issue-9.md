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
- Active-resize acceptance first exercised an intentional top-work-area clamp. The fixture was moved lower so both sizes fit and exact foot preservation applies; the product correctly retains the clamp when a larger pet would extend beyond the screen.
- GREEN: active held/falling resize acceptance passed at 1x in 32.31 seconds.
- GREEN: development 1x size interactions, body and edge clicks, transparent corner rejection, dragging, catching during return, hidden size persistence and preference recovery passed in 30.62 seconds before adding active-resize acceptance.

Regression host: macOS 27.0.1 (26A434), arm64; development Node 24.18.0, Electron 44.9.1.

Development regression matrix, source `f150574` (integration merge `f6ef13e`):

| Mode        | Forced scale | Result                                                       | Duration |
| ----------- | ------------ | ------------------------------------------------------------ | -------- |
| Development | 1x           | 3 files passed; 3 tests passed, 1 packaged-only test skipped | 85.30 s  |
| Development | 2x           | 3 files passed; 3 tests passed, 1 packaged-only test skipped | 89.23 s  |

Commands use `MOSEY_TEST_SCALE_FACTOR=1` or `2` with `pnpm exec vitest run --project development tests/size.test.ts tests/visibility.test.ts tests/app.test.ts`. This jointly regresses #4's existing drag/return suite and #6's existing visibility suite. `pnpm check` passes.

The parent built the integration merge with `pnpm package:mac`; the packaged matrix tests a copy of that exact deliverable, rather than a separate build.

| Mode     | Forced scale | Result                         | Duration |
| -------- | ------------ | ------------------------------ | -------- |
| Packaged | 1x           | 3 files passed; 4 tests passed | 78.48 s  |

Packaged 2x also passed all 3 files and all 4 tests in 81.29 seconds. Both forced-scale runs use the same integration deliverable.

The packaged command uses the same file list with `--project packaged`. The additional packaged-only test starts a relocated app with a minimal shell environment and no inspector bootstrap.

## Evidence limits and remaining desktop acceptance

Directed Playwright events and screenshots prove application coordinate handling. They do not prove cross-application OS routing, first physical click after fast cursor entry, native menu tracking, focus behavior, or clicks reaching the application underneath. Those require actual desktop input. The existing 8 ms pointer polling adapter retains its previously documented first-click race; this ticket does not claim that the race is solved.

Forced 1x/2x Chromium scale factors test rendering/coordinate paths on this machine; they do not establish coverage of multiple physical display models, every macOS scaling setting, or other macOS versions. The screenshot proportions preserve the existing character and grounded paws at all three pixel sizes, but actual desktop presence and final dimension tuning require the parent task's real-desktop review. Keep unverified acceptance open instead of describing directed events as physical-input evidence.

Tracked 1x Canvas samples: [small](issue-9-small.png), [medium](issue-9-medium.png), [large](issue-9-large.png). These are rendered-window samples, not full desktop input-routing evidence.

## Real desktop acceptance — 2026-10-21

After the four local automated matrix rows passed, the integration bundle built at `f6ef13e` was launched with a fresh temporary profile and native Retina scale (2x). Its `app.asar` SHA-256 was `d6443b7f7ccbe50fa786952737202fde72190d9b96dcdb942b04c3f3a8c39f58`. This is the same bundle tested by the implementation agent; subsequent changes at this point affect tests and documentation only.

The user used the actual mouse and reported **“全部正常”** for the requested checks at Small, Medium and Large: desktop dimensions and complete action appearance/grounding; fast entry followed by the first body click and body-edge clicks; transparent-corner clicks reaching the application below; lifting and dragging outside the original window, release/return and catching again during return. The 180/240/300 DIP values are accepted for this local desktop review. This feedback supplies the physical-input and desktop tuning evidence left pending in the initial implementation section above; it does not establish other displays, macOS versions or every possible input timing.

A separate read-only observer injected no inputs. It recorded all three window sizes, 111 distinct window rectangles, five press/release and capture/loss pairs, and 199 held pointer movements. Its sampled gestures were at Small; three crossed the initial window rectangle and two began while the window was above the ground. These observations supplement the user's full three-size feedback; they do not independently prove each requested click or action in every size. The observer recorded only pet-window geometry and DOM pointer events, not other applications' content. See [desktop observation summary](issue-9-desktop-summary.json). The raw local `/tmp/mosey-issue-9/native-input.jsonl` is not published.

The temporary observation app was shut down normally after the feedback so further automated diagnostics could run in isolation. Keyboard-focus preservation remains outside the accepted scope, as recorded in the final #4 scope clarification.

## CI follow-up in progress

The initial remote run `39549360533` failed the first resized-foot assertion by one DIP (707 observed, 706 expected). The same-code follow-up `39549650877` reached the active-resize fixture but failed because its interpolated client-coordinate moves accumulated as the window moved: on the smaller CI desktop the pet reached the top, and increasing to 300 DIP correctly clamped its foot to 325 rather than retaining an impossible 265. The fixture now uses one move to produce the intended lift while retaining exact anchor assertions. The second run also failed in visibility-frame sampling with a destroyed execution context during navigation; the earlier concurrent-build explanation is unconfirmed and insufficient to explain this isolated CI occurrence.

Temporary failure-only native-boundary and navigation diagnostics have been added without relaxing assertions or changing product code. Remote diagnosis and final CI verification remain pending; local matrix and user desktop acceptance are not presented as a passing remote CI result.
