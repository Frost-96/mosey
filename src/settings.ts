import type { Settings } from "./shared/contract";
document.documentElement.dataset.page = "settings";
document.querySelector<HTMLLinkElement>("#settings-style")!.media = "all";
document.title = "Mosey 设置";
document.body.innerHTML = `<main><h1>设置</h1><section aria-labelledby="pet-heading"><h2 id="pet-heading">宠物</h2><div class="pet-card"><span class="pet-mark" aria-hidden="true">🐾</span><div><strong>柯基</strong><p>好奇，又有点懒。</p></div><span class="selected">已选中</span></div></section><section aria-labelledby="size-heading"><h2 id="size-heading">大小</h2><p>当前大小 <output aria-live="polite"></output></p><div class="presets"><button data-size="70">小</button><button data-size="160">中（默认）</button><button data-size="240">大</button></div><input type="range" aria-label="宠物大小" min="70" max="240" step="10" value="160"><p class="hint">窗口边长，以 DIP 为单位。</p><div class="hidden-notice" hidden>宠物已隐藏 <button id="show">显示宠物</button></div><div class="error" hidden><p role="alert">保存失败，已保留上次保存的大小。</p><button id="retry">重试</button></div></section><section><h2>开机启动</h2><p class="hint">请通过菜单中的 Launch at Login 管理。</p></section></main>`;
let state: Settings;
let operation = 0;
let pending = 0;
let communicationFailure: number | undefined;
let dirty = false;
let keyboardCommit: ReturnType<typeof setTimeout> | undefined;
const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
const render = (next: Settings) => {
  state = next;
  communicationFailure = undefined;
  document.querySelector(".error [role=alert]")!.textContent =
    "保存失败，已保留上次保存的大小。";
  slider.value = String(next.size);
  document.querySelector("output")!.textContent = String(next.size);
  document
    .querySelectorAll<HTMLButtonElement>("[data-size]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.size) === next.size),
      ),
    );
  document.querySelector<HTMLElement>(".hidden-notice")!.hidden =
    next.visibility !== "hidden";
  document.querySelector<HTMLElement>(".error")!.hidden =
    next.failedSize === undefined;
};
const select = async (size: number, commit = true) => {
  const request = ++operation;
  pending++;
  try {
    const result = await (commit
      ? window.moseySettings.setSize(size)
      : window.moseySettings.previewSize(size));
    if (request === operation) render(result);
  } catch {
    if (request === operation) {
      communicationFailure = size;
      document.querySelector(".error [role=alert]")!.textContent =
        "无法确认保存结果，请重试。";
      document.querySelector<HTMLElement>(".error")!.hidden = false;
    }
  } finally {
    pending--;
  }
};
const commitSlider = () => {
  clearTimeout(keyboardCommit);
  if (!dirty) return;
  dirty = false;
  void select(Number(slider.value));
};
slider.addEventListener("input", () => {
  dirty = true;
  void select(Number(slider.value), false);
  clearTimeout(keyboardCommit);
  // Native range inputs also emit input for keyboard changes. Pointer release
  // commits explicitly; keyboard inactivity provides the equivalent boundary.
  if (!dragging) keyboardCommit = setTimeout(commitSlider, 250);
});
let dragging = false;
slider.addEventListener("pointerdown", () => {
  dragging = true;
  clearTimeout(keyboardCommit);
});
window.addEventListener("pointerup", () => {
  dragging = false;
  commitSlider();
});
slider.addEventListener("pointercancel", () => {
  dragging = false;
  commitSlider();
});
const finishGesture = () => {
  dragging = false;
  commitSlider();
};
slider.addEventListener("lostpointercapture", finishGesture);
slider.addEventListener("blur", finishGesture);
window.addEventListener("blur", finishGesture);
document.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((button) =>
  button.addEventListener("click", () => {
    dirty = false;
    clearTimeout(keyboardCommit);
    void select(Number(button.dataset.size));
  }),
);
document.querySelector("#retry")!.addEventListener("click", () => {
  const target = communicationFailure ?? state.failedSize;
  if (target !== undefined) void select(target);
});
document.querySelector("#show")!.addEventListener("click", () => {
  const request = operation;
  void window.moseySettings.showPet().then((next) => {
    if (request === operation) receive(next);
  });
});
function receive(next: Settings) {
  if (!pending) render(next);
  else
    document.querySelector<HTMLElement>(".hidden-notice")!.hidden =
      next.visibility !== "hidden";
}
window.moseySettings.onChange(receive);
void window.moseySettings.get().then((next) => {
  if (operation === 0) render(next);
});
