import { characterResourceKey } from "../../shared/character-catalog";
import type { PreparedCharacter } from "../../shared/characters";
import { characterGeometry } from "../../shared/character-geometry";
import type { CharacterPreparation, Presentation } from "../../shared/contract";

try {
  const initial = await window.mosey.getPresentation();
  const loadAssets = async (
    character: PreparedCharacter,
    signal?: AbortSignal,
  ) => {
    const { atlases } = character;
    const images = new Map<string, HTMLImageElement>();
    await Promise.all(
      atlases.map(async (atlas) => {
        const loadImage = async (filename: string) => {
          signal?.throwIfAborted();
          const image = new Image();
          const url = character.images[filename];
          if (!url)
            throw new Error(`Missing ${character.id} ${atlas.action} image`);
          image.crossOrigin = "anonymous";
          image.src = url;
          const abort = () => {
            image.src = "";
          };
          signal?.addEventListener("abort", abort, { once: true });
          try {
            await image.decode();
          } finally {
            signal?.removeEventListener("abort", abort);
          }
          signal?.throwIfAborted();
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
    return {
      ...character,
      atlases,
      images,
      geometry: characterGeometry(atlases),
    };
  };
  const prepared = new Map<string, Awaited<ReturnType<typeof loadAssets>>>();
  let assets = await loadAssets(await window.mosey.getCharacter());
  prepared.set(characterResourceKey(initial), assets);
  let retired = false;
  let latestPreparation: CharacterPreparation | undefined;
  let preparation: AbortController | undefined;
  const unsubscribeRetention = window.mosey.onRetainCharacter((retained) => {
    if (
      latestPreparation &&
      (retained.generation < latestPreparation.generation ||
        (retained.generation === latestPreparation.generation &&
          retained.request < latestPreparation.request))
    )
      return;
    latestPreparation = undefined;
    preparation?.abort();
    const key = characterResourceKey(retained);
    for (const entry of prepared.keys())
      if (entry !== key) prepared.delete(entry);
  });
  const unsubscribePreparation = window.mosey.onPrepareCharacter(
    async (request) => {
      preparation?.abort();
      preparation = new AbortController();
      const controller = preparation;
      latestPreparation = request;
      const { assets: descriptor, ...identity } = request;
      try {
        const key = characterResourceKey(request);
        const candidate =
          prepared.get(key) ??
          (await loadAssets(descriptor, controller.signal));
        if (retired || latestPreparation !== request) return;
        prepared.set(key, candidate);
        for (const entry of prepared.keys())
          if (entry !== key && entry !== characterResourceKey(presentation))
            prepared.delete(entry);
        window.mosey.characterPrepared({ ...identity, success: true });
      } catch {
        controller.abort();
        if (!retired && latestPreparation === request)
          window.mosey.characterPrepared({ ...identity, success: false });
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
    const cssSide = `${side}px`;
    if (
      canvas!.width !== Math.round(side * ratio) ||
      canvas!.height !== Math.round(side * ratio) ||
      // The HTML backing size can already match (160 DIP at 1.5x = 240px).
      // CSS size also distinguishes that uninitialized first draw.
      canvas!.style.width !== cssSide ||
      canvas!.style.height !== cssSide
    ) {
      canvas!.width = Math.round(side * ratio);
      canvas!.height = Math.round(side * ratio);
      canvas!.style.width = cssSide;
      canvas!.style.height = cssSide;
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
    if (characterResourceKey(value) !== characterResourceKey(presentation)) {
      const candidate = prepared.get(characterResourceKey(value));
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
      looking: "张望",
      sittingdown: "坐下",
      sitting: "坐着休息",
      standingup: "站起来",
      yawning: "打哈欠",
      petted: "被抚摸",
      grooming: "整理仪容",
      celebrating: "庆祝",
      habit: "小习惯",
    };
    canvas!.setAttribute(
      "aria-label",
      `${assets.name} · ${actionNames[value.posture]}`,
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
      preparation?.abort();
      finish("cancel");
      unsubscribePreparation();
      unsubscribeRetention();
      unsubscribe();
      unsubscribeCancellation();
      cancelDrawing();
    },
    { once: true },
  );
} catch (error) {
  window.mosey.reportAssetError(String(error).slice(0, 500));
}
