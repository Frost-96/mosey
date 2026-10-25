# #3 source asset production

Tool: built-in image_gen (not CLI); existing `src/assets/corgi-idle.png` supplied as character identity reference; transparent_background=true. Output must be copied into src/assets before final delivery.

Prompt set: identity-preserve production desktop-pet animation sheet. Four equal 2x2 cells, row-major. Same orange/white outlined shaded corgi, white chest/blaze, brown eyes, big triangular ears, short legs. Fixed camera, scale and ground contact, no text/grid/shadow. Entire dog per cell with transparent margin, exactly four legs. Requested 1024 square (actual metadata must be read).

- tilt: neutral standing -> head turns toward viewer and begins tilting -> stronger curious head tilt -> partial recovery toward neutral. Keep body and paws consistent.
- paw: neutral standing -> near front paw lifts with bent elbow -> extends paw forward/up to offer a shake -> lowers paw partway toward stance. Other three paws support body.
- belly: neutral standing -> squat/lean toward viewer -> lies on side rolling, white belly visible -> fully belly-up with four short paws raised. Intended forward then reverse playback to stand.

These generated poses need pipeline normalization, current-frame alpha generation, and actual-size animation review; source generation is not acceptance evidence. Original built-in outputs remain in /Users/frost/.codex/generated_images/01a159aa-ff83-77f1-8ad0-0947385907e0/.

Actual final sheets: all 1254 × 1254 RGBA, four 627 × 627 cells. Belly v1 was rejected because the lower pose crossed the quadrant boundary and clipped at the right edge; final belly source was regenerated with larger transparent margins and inspected before integration. Final 2x atlases are built with one proportional scale per action, complete silhouettes and common bottom anchors. The generated image provider did not honor the requested 1024 size, so the pipeline reads actual metadata.
