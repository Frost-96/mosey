# Issue 9 — three sizes

The original implementation, bundle hashes, desktop feedback and CI diagnosis below are historical evidence from before the mainline autonomy integration. The final section records the newer combined implementation and its acceptance scope.

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

## CI diagnosis and corrected acceptance readiness

Remote runs exposed acceptance-fixture defects without identifying a product sizing defect. Run `39549360533` reported a one-DIP foot difference (707 versus 706); its original snapshot lacked the work-area context needed to identify the cause. Run `39549650877` reached the active-resize scenario, where interpolated client-coordinate moves compounded as the native window moved. On the smaller CI display this reached the top; the 300-DIP pet correctly clamped to a reachable foot at 325 rather than preserving an impossible 265. The fixture now uses one move for the intended screen displacement and retains exact anchor assertions.

The visibility sampling failure was reproduced locally twice in a minimized cold-start loop, each failing in about five seconds with `Execution context was destroyed`. Remote chronology showed native visibility was already true while `webContents.isLoading()` was still true; the document had not completed its initial load. This supports an initial-document readiness race; the earlier concurrent-build/HMR explanation was not established. Changing only the sampling boundary to await the actual page load lifecycle made 20 cold launches pass in 24.42 seconds. Tests now wait for every relaunched document and for actual opaque pixels before taking visible geometry/frame samples. They do not catch and ignore evaluation errors or loosen anchor tolerances.

The decisive native-boundary evidence in run `39551781880` showed a real **work-area change**, not native rounding: height changed from 681 to 682 at y=25, moving the current floor from 706 to 707. The application received `display-metrics-changed`, requested y=407 for the 300-DIP window and read back exactly y=407; Show therefore correctly retained the current floor at 707. The failed test compared that correct result with the previous process's stale floor at 706, contradicting the requirement to recompute the current primary ground on restart. See the [trimmed public geometry trace](issue-9-work-area-change.json). The earlier native-offset/show-adjustment interpretation was unsupported and is withdrawn.

Restart and landing checks now compare exact window feet with an atomic snapshot of the **current** primary work area. Size-only changes additionally preserve the pre-resize physical foot when the work area is unchanged. The loaded hidden-start → Show → exact-current-ground probe passed in that same remote run. No product positioning offset or show-handler patch was justified. At that pre-integration checkpoint runtime source remained the implementation at `f150574`; that statement does not cover the subsequent mainline autonomy merge.

That run also exposed a Dock diagnostic fixture budget mismatch: the helper emits stream configuration before awaiting `startCapture()`, then emits its first heartbeat after capture startup plus its 100ms interval. The existing product watchdog allows 2000ms and checks every 250ms, while Vitest's default poll allowed only 1000ms. The first-heartbeat observation now allows 2500ms to cover that existing watchdog and sampling/file-observation margin. Product deadlines, later SIGSTOP fault checks and heartbeat assertions are unchanged. Bounded raw diagnostic logs are copied on future failures before profile cleanup.

All temporary native-method wrappers, navigation logs, debug tags, diagnostic test files and extra workflow runs were removed after the targeted diagnosis. Original failure screenshots and process cleanup remain in the acceptance tests. The exact startup and resized-foot assertions, rendered-pixel checks, one-move active-resize fixture and relaunch readiness remain as regression coverage.

Final full remote CI passed for implementation/test commit `224a734b85d2f63f6ada2c91e05a223b4f0ff8ad`: [run 39552868869](https://github.com/Frost-96/mosey/actions/runs/39552868869). Checks, full development tests (3 passed / 1 packaged-only skipped, 115.07 s), Apple Silicon packaging, full packaged tests (4 passed, 76.88 s), and artifact upload all succeeded. Subsequent commits update validation documentation only; their runtime, test, dependency and workflow content matches that tested commit. The final documentation commit skips a duplicate CI run after checking this exact content equality.

After correcting current-floor and first-heartbeat expectations, `pnpm check` passed. The latest forced-2x regression results are:

| Mode        | Result                                                     | Duration |
| ----------- | ---------------------------------------------------------- | -------- |
| Development | Full 3 files; 3 tests passed, 1 packaged-only test skipped | 90.33 s  |
| Packaged    | Focused size/visibility: 2 files, 2 tests passed           | 39.72 s  |

Commands used `MOSEY_TEST_SCALE_FACTOR=2 pnpm exec vitest run --project development tests/size.test.ts tests/app.test.ts tests/visibility.test.ts` and `MOSEY_TEST_SCALE_FACTOR=2 pnpm exec vitest run --project packaged tests/size.test.ts tests/visibility.test.ts`. The packaged check used the unchanged user-reviewed bundle; its `app.asar` hash was rechecked as `d6443b7f7ccbe50fa786952737202fde72190d9b96dcdb942b04c3f3a8c39f58`.

## Original size-only review and disposition (before mainline integration)

The final Standards and Spec reviews each reported zero unresolved findings. The user confirmed all requested three-size physical desktop checks; automated size/persistence/recovery coverage and the complete remote pipeline passed. Issue #9 is complete within this recorded local desktop and automated matrix. The parent specification and other feature tickets remain independent; this work is delivered on `integration/issue-9-size`. The implementation worktree was submitted for archival after its final evidence was copied to the integration worktree.

## Mainline autonomy integration — PR 26

Integration `bbaf5e8` merges mainline `c5a8b1f` and its autonomous walking, stretching and playing. Rendering and mirrored hit mapping use the current shared size geometry; walking computes movement from the physical foot and current window dimensions instead of keeping an old window corner across resize. The user-reviewed `f6ef13e` bundle/hash and physical-input feedback above predate this integration. They are not presented as physical acceptance of the new combined autonomous behavior.

The new `tests/size-autonomy.test.ts` drives real Electron through public menu actions, rendered pixels, native window bounds and directed pointer input. It covers moving resizes 180→300, 300→240 and 240→180 DIP; exact physical-foot preservation and current ground; subsequent walking continuity and completion; left-facing idle silhouettes; asymmetric opaque-body and transparent-reflection click targets while walking; continued movement after transparent clicks and stopped movement after body clicks; and scaled, grounded stretching/playing with drag interruption, held-position stability and return at all three final sizes. Long-rest delays and randomness are controlled only at their external time/random boundaries; animation and window movement run in real time. No production test hooks or internal behavior-state assertions were added.

Two fixture corrections were measured before the combined test passed. At 300 DIP, mirroring an already-resampled Canvas produced six opacity-threshold contour-pixel differences out of 90,000 pixels compared with rendering the mirrored source; exact RGBA copies are not a valid reference for that resampling order. The new silhouette observer allows at most one backing-pixel contour difference and at most 1/3000 changed canvas pixels. Actual opposite-facing frames are required negative controls and are rejected at every size. Ground, foot and window-position assertions remain exact. A separate pointer trace showed a bow target changing from alpha 253 on move to alpha 59 on press one millisecond later; the drag fixture now selects an opaque interior with 8-DIP clearance rather than that moving contour. Temporary pointer/image diagnostics were removed.

The focused combined development test passed locally at forced 1x in 52.20 seconds. Its aggregate 120-second budget covers three walking/resize/click cases and six autonomous pose/drag/return cases on slower CI hosts; individual response deadlines remain short and unchanged. Existing full integration suites at `bbaf5e8` also passed before this new coverage was added. For the current PR head, the authoritative combined pipeline result is the [PR 26 checks page](https://github.com/Frost-96/mosey/pull/26/checks); later local full-suite results are recorded in the PR review rather than requiring a documentation-only CI-skipping commit.

These new directed-event and rendered-window checks do not establish OS cross-application routing or human visual approval for every new autonomous frame at every size. The historical three-size mouse acceptance remains accurately scoped to its tested earlier bundle.
