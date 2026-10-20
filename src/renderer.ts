import idleUrl from "./assets/generated/idle-atlas.png";
import metadata from "./assets/generated/idle-atlas.json";
import { atlasSchema } from "./shared/assets";
import type { Presentation } from "./shared/contract";

async function startRenderer() {
  try {
    console.info("DEBUG-pr18 renderer-module-entered");
    const atlas = atlasSchema.parse(metadata);
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("Pet canvas is absent");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    const image = new Image();
    image.src = idleUrl;
    console.info("DEBUG-pr18 atlas-decode-start", idleUrl);
    await image.decode();
    console.info("DEBUG-pr18 atlas-decode-complete", image.width, image.height);
    if (image.width !== atlas.width || image.height !== atlas.height)
      throw new Error("Atlas pixels do not match metadata");
    // Keep Canvas details here; metadata uses only image-space geometry.
    const scale = window.devicePixelRatio;
    canvas.width = Math.round(240 * scale);
    canvas.height = Math.round(240 * scale);
    canvas.style.width = "240px";
    canvas.style.height = "240px";
    context.scale(scale, scale);
    const total = atlas.frames.reduce(
      (sum, frame) => sum + frame.durationMs,
      0,
    );
    const started = performance.now();
    let previous = -1;
    let scheduled = 0;
    let presentation: Presentation = {
      posture: "resting",
      visibility: "hidden",
    };
    function draw(now: number) {
      scheduled = 0;
      if (presentation.visibility !== "visible" || document.hidden) return;
      let remaining = (now - started) % total;
      let index = 0;
      for (const frame of atlas.frames) {
        if (remaining < frame.durationMs) break;
        remaining -= frame.durationMs;
        index++;
      }
      if (index !== previous) {
        const frame = atlas.frames[index]!;
        const { region, foot } = frame;
        context!.clearRect(0, 0, 240, 240);
        context!.drawImage(
          image,
          region.x,
          region.y,
          region.width,
          region.height,
          120 - foot.x / atlas.pixelRatio,
          240 - foot.y / atlas.pixelRatio,
          region.width / atlas.pixelRatio,
          region.height / atlas.pixelRatio,
        );
        previous = index;
      }
      scheduled = requestAnimationFrame(draw);
    }
    function synchronize(value: Presentation) {
      presentation = value;
      if (scheduled) cancelAnimationFrame(scheduled);
      scheduled = 0;
      if (value.visibility === "visible" && !document.hidden)
        scheduled = requestAnimationFrame(draw);
    }
    const unsubscribe = window.mosey.onPresentation(synchronize);
    synchronize(await window.mosey.getPresentation());
    console.info(
      "DEBUG-pr18 renderer-synchronized",
      presentation,
      document.visibilityState,
      canvas.width,
      canvas.height,
    );
    document.addEventListener("visibilitychange", () =>
      synchronize(presentation),
    );
    window.addEventListener(
      "pagehide",
      () => {
        unsubscribe();
        cancelAnimationFrame(scheduled);
      },
      { once: true },
    );
  } catch (error) {
    window.mosey.reportAssetError(String(error).slice(0, 500));
  }
}

void startRenderer();
