import {
  characterAssets,
  characterDirectory,
  type CharacterId,
} from "./shared/characters";
import { characterGeometry } from "./shared/character-geometry";
import type { Presentation } from "./shared/contract";

try {
  const initial = await window.mosey.getPresentation();
  const urls = import.meta.glob("./assets/generated/**/*.png", {
    eager: true,
    import: "default",
    query: "?url",
  });
  const loadAssets = async (character: CharacterId) => {
    const atlases = characterAssets(character);
    const images = new Map<string, HTMLImageElement>();
    await Promise.all(
      atlases.map(async (atlas) => {
        const loadImage = async (filename: string) => {
          const image = new Image();
          const url =
            urls[
              `./assets/generated/${characterDirectory(character)}${filename}`
            ];
          if (typeof url !== "string")
            throw new Error(`Missing ${character} ${atlas.action} image`);
          image.src = url;
          await image.decode();
          if (image.width !== atlas.width || image.height !== atlas.height)
            throw new Error("Atlas pixels do not match metadata");
          images.set(filename, image);
        };
        await Promise.all([
          loadImage(atlas.image),
          atlas.leftImage ? loadImage(atlas.leftImage) : undefined,
        ]);
      }),
    );
    return { atlases, images, geometry: characterGeometry(atlases) };
  };
  const prepared = new Map<
    CharacterId,
    Awaited<ReturnType<typeof loadAssets>>
  >();
  let assets = await loadAssets(initial.character);
  prepared.set(initial.character, assets);
  let retired = false;
  const unsubscribePreparation = window.mosey.onPrepareCharacter(
    async (request) => {
      try {
        const candidate =
          prepared.get(request.character) ??
          (await loadAssets(request.character));
        if (retired) return;
        prepared.set(request.character, candidate);
        window.mosey.characterPrepared({ ...request, success: true });
      } catch {
        if (!retired)
          window.mosey.characterPrepared({ ...request, success: false });
      }
    },
  );
  const canvas = document.querySelector("canvas");
  if (!canvas) throw new Error("Pet canvas is absent");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  let previous = "",
    frameRequest = 0,
    frameTimer = 0,
    completed = -1;
  let presentation: Presentation = initial;
  function cancelDrawing() {
    clearTimeout(frameTimer);
    cancelAnimationFrame(frameRequest);
    frameTimer = 0;
    frameRequest = 0;
  }
  function requestDraw() {
    frameTimer = 0;
    if (
      presentation.visibility === "visible" &&
      presentation.frozenAt === undefined &&
      !document.hidden
    )
      frameRequest = requestAnimationFrame(draw);
  }
  function draw() {
    frameRequest = 0;
    if (presentation.visibility !== "visible" || document.hidden) return;
    const side = presentation.size;
    // A new primary display can change backing scale without changing CSS size.
    // Check every visible draw, including the first draw after hiding.
    const ratio = window.devicePixelRatio;
    if (
      canvas!.width !== Math.round(side * ratio) ||
      canvas!.height !== Math.round(side * ratio)
    ) {
      canvas!.width = Math.round(side * ratio);
      canvas!.height = Math.round(side * ratio);
      canvas!.style.width = `${side}px`;
      canvas!.style.height = `${side}px`;
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
      previous = "";
    }
    const atlas = assets.atlases.find(
      (atlas) => atlas.action === presentation.posture,
    );
    if (!atlas)
      throw new Error(
        `Unsupported ${presentation.character} action: ${presentation.posture}`,
      );
    const total = atlas.frames.reduce(
      (sum, frame) => sum + frame.durationMs,
      0,
    );
    const elapsed = Math.max(
      0,
      (presentation.frozenAt ?? Date.now()) - presentation.startedAt,
    );
    if (atlas.loop === "once" && elapsed >= total) {
      if (
        presentation.frozenAt === undefined &&
        completed !== presentation.actionId
      ) {
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
      const key = `${presentation.geometryRevision}:${presentation.actionId}:${presentation.direction}:${index}`;
      if (key !== previous) {
        const { drawing } = assets.geometry.frame({
          ...presentation,
          frame: index,
        })!;
        const { source } = drawing;
        context!.clearRect(0, 0, side, side);
        context!.save();
        context!.transform(...drawing.transform);
        context!.drawImage(
          assets.images.get(drawing.image)!,
          source.x,
          source.y,
          source.width,
          source.height,
          0,
          0,
          source.width,
          source.height,
        );
        context!.restore();
        window.mosey.input({
          type: "frame",
          geometryRevision: presentation.geometryRevision,
          actionId: presentation.actionId,
          frame: index,
        });
        previous = key;
      }
    }
    if (
      presentation.frozenAt !== undefined ||
      (atlas.loop === "once" && elapsed >= total)
    )
      return;
    let boundary = 0;
    for (const frame of atlas.frames) {
      boundary += frame.durationMs;
      if (boundary > elapsed % total) break;
    }
    // Sleep until the next pose, then align the actual Canvas work with refresh.
    frameTimer = window.setTimeout(
      requestDraw,
      Math.max(1, boundary - (elapsed % total)),
    );
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
    if (event.button !== 0 || event.ctrlKey || gesture) return;
    const rect = canvas.getBoundingClientRect();
    gesture = { pointerId: event.pointerId, id: ++nextGesture };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    window.mosey.input({
      type: "press",
      geometryRevision: presentation.geometryRevision,
      actionId: presentation.actionId,
      gestureId: gesture.id,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      screenX: event.screenX,
      screenY: event.screenY,
    });
  });
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (gesture) return;
    cancelDrawing();
    const rect = canvas.getBoundingClientRect();
    window.mosey.input({
      type: "context",
      geometryRevision: presentation.geometryRevision,
      actionId: presentation.actionId,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
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
    if (value.geometryRevision !== presentation.geometryRevision)
      finish("cancel");
    if (value.frozenAt !== undefined) completed = -1;
    if (value.character !== presentation.character) {
      const candidate = prepared.get(value.character);
      if (!candidate)
        throw new Error("Character was not prepared before commit");
      assets = candidate;
      previous = "";
    }
    presentation = value;
    const actionNames: Record<Presentation["posture"], string> = {
      resting: "待机",
      sleeping: "睡觉",
      ear: "睡眠回应",
      waking: "醒来",
      settling: "入睡",
      walking: "走路",
      stretching: "伸展",
      playing: "玩耍",
      tilt: "歪头",
      paw: "回应",
      belly: "放松",
      dragging: "拖拽",
      flutter: "扑腾",
      falling: "下落",
      landing: "落地",
      climbing: "攀爬",
    };
    canvas!.setAttribute(
      "aria-label",
      `${value.character === "whale" ? "鲸鱼娘" : "柯基"} · ${actionNames[value.posture]}`,
    );
    cancelDrawing();
    requestDraw();
  }
  // A queued cancellation belongs to one captured gesture, never to a newer
  // press that happened before its main-process messages reached this renderer.
  const unsubscribeCancellation = window.mosey.onGestureCancellation((id) => {
    if (gesture?.id === id) finish("cancel");
  });
  const unsubscribe = window.mosey.onPresentation(synchronize);
  synchronize(await window.mosey.getPresentation());
  window.mosey.assetsReady();
  window.addEventListener("resize", () => synchronize(presentation));
  document.addEventListener("visibilitychange", () =>
    synchronize(presentation),
  );
  window.addEventListener(
    "pagehide",
    () => {
      retired = true;
      finish("cancel");
      unsubscribePreparation();
      unsubscribe();
      unsubscribeCancellation();
      cancelDrawing();
    },
    { once: true },
  );
} catch (error) {
  window.mosey.reportAssetError(String(error).slice(0, 500));
}
