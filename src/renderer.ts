import walkingUrl from "./assets/generated/walking-atlas.png";
import walking from "./assets/generated/walking-atlas.json";
import stretchingUrl from "./assets/generated/stretching-atlas.png";
import stretching from "./assets/generated/stretching-atlas.json";
import playingUrl from "./assets/generated/playing-atlas.png";
import playing from "./assets/generated/playing-atlas.json";
import idleUrl from "./assets/generated/idle-atlas.png";
import tiltUrl from "./assets/generated/tilt-atlas.png";
import pawUrl from "./assets/generated/paw-atlas.png";
import bellyUrl from "./assets/generated/belly-atlas.png";
import idle from "./assets/generated/idle-atlas.json";
import tilt from "./assets/generated/tilt-atlas.json";
import paw from "./assets/generated/paw-atlas.json";
import belly from "./assets/generated/belly-atlas.json";
import draggingUrl from "./assets/generated/dragging-atlas.png";
import dragging from "./assets/generated/dragging-atlas.json";
import flutterUrl from "./assets/generated/flutter-atlas.png";
import flutter from "./assets/generated/flutter-atlas.json";
import fallingUrl from "./assets/generated/falling-atlas.png";
import falling from "./assets/generated/falling-atlas.json";
import landingUrl from "./assets/generated/landing-atlas.png";
import landing from "./assets/generated/landing-atlas.json";
import { atlasSchema } from "./shared/assets";
import type { Presentation } from "./shared/contract";

try {
  const assets = await Promise.all(
    [
      [idle, idleUrl],
      [walking, walkingUrl],
      [stretching, stretchingUrl],
      [playing, playingUrl],
      [tilt, tiltUrl],
      [paw, pawUrl],
      [belly, bellyUrl],
      [dragging, draggingUrl],
      [flutter, flutterUrl],
      [falling, fallingUrl],
      [landing, landingUrl],
    ].map(async ([metadata, url]) => {
      const atlas = atlasSchema.parse(metadata);
      const image = new Image();
      image.src = String(url);
      await image.decode();
      if (image.width !== atlas.width || image.height !== atlas.height)
        throw new Error("Atlas pixels do not match metadata");
      return { atlas, image };
    }),
  );
  const canvas = document.querySelector("canvas");
  if (!canvas) throw new Error("Pet canvas is absent");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  const scale = window.devicePixelRatio;
  canvas.width = Math.round(240 * scale);
  canvas.height = Math.round(240 * scale);
  canvas.style.width = "240px";
  canvas.style.height = "240px";
  context.scale(scale, scale);
  let previous = "",
    scheduled = 0,
    completed = -1;
  let presentation: Presentation = {
    posture: "resting",
    direction: "right",
    visibility: "hidden",
    actionId: 0,
    startedAt: Date.now(),
  };
  function draw() {
    scheduled = 0;
    if (presentation.visibility !== "visible" || document.hidden) return;
    const { atlas, image } = assets.find(
      (asset) => asset.atlas.action === presentation.posture,
    )!;
    const total = atlas.frames.reduce(
      (sum, frame) => sum + frame.durationMs,
      0,
    );
    const elapsed = Math.max(0, Date.now() - presentation.startedAt);
    if (atlas.loop === "once" && elapsed >= total) {
      if (completed !== presentation.actionId) {
        completed = presentation.actionId;
        window.mosey.input({ type: "done", actionId: completed });
      }
    } else {
      let remaining = elapsed % total,
        index = 0;
      for (const frame of atlas.frames) {
        if (remaining < frame.durationMs) break;
        remaining -= frame.durationMs;
        index++;
      }
      const key = `${presentation.actionId}:${presentation.direction}:${index}`;
      if (key !== previous) {
        const { region, foot } = atlas.frames[index]!;
        context!.clearRect(0, 0, 240, 240);
        context!.save();
        if (presentation.direction === "left") {
          context!.translate(240, 0);
          context!.scale(-1, 1);
        }
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
        context!.restore();
        window.mosey.input({
          type: "frame",
          actionId: presentation.actionId,
          frame: index,
        });
        previous = key;
      }
    }
    scheduled = requestAnimationFrame(draw);
  }
  let gesture: { pointerId: number; id: number } | undefined;
  let nextGesture = 0;
  function finish(type: "release" | "cancel") {
    const current = gesture;
    if (!current) return;
    gesture = undefined;
    window.mosey.input({ type, gestureId: current.id });
    if (canvas!.hasPointerCapture(current.pointerId))
      canvas!.releasePointerCapture(current.pointerId);
  }
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || gesture) return;
    const rect = canvas.getBoundingClientRect();
    gesture = { pointerId: event.pointerId, id: ++nextGesture };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    window.mosey.input({
      type: "press",
      actionId: presentation.actionId,
      gestureId: gesture.id,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      screenX: event.screenX,
      screenY: event.screenY,
    });
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1)) return finish("cancel");
    window.mosey.input({
      type: "move",
      gestureId: gesture.id,
      screenX: event.screenX,
      screenY: event.screenY,
    });
  });
  canvas.addEventListener("pointerup", (event) => {
    if (event.button === 0 && gesture?.pointerId === event.pointerId)
      finish("release");
  });
  canvas.addEventListener("pointercancel", () => finish("cancel"));
  canvas.addEventListener("lostpointercapture", () => finish("cancel"));
  window.addEventListener("blur", () => finish("cancel"));
  function synchronize(value: Presentation) {
    if (value.visibility === "hidden") finish("cancel");
    presentation = value;
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = 0;
    if (value.visibility === "visible" && !document.hidden)
      scheduled = requestAnimationFrame(draw);
  }
  const unsubscribe = window.mosey.onPresentation(synchronize);
  synchronize(await window.mosey.getPresentation());
  document.addEventListener("visibilitychange", () =>
    synchronize(presentation),
  );
  window.addEventListener(
    "pagehide",
    () => {
      finish("cancel");
      unsubscribe();
      cancelAnimationFrame(scheduled);
    },
    { once: true },
  );
} catch (error) {
  window.mosey.reportAssetError(String(error).slice(0, 500));
}
