import type { Settings } from "./shared/contract";
import { attachLoginSettings } from "./settings-login";
document.documentElement.dataset.page = "settings";
document.querySelector<HTMLLinkElement>("#settings-style")!.media = "all";
document.title = "Mosey 设置";
document.body.innerHTML = `<main><h1>设置</h1><section aria-labelledby="pet-heading"><h2 id="pet-heading">宠物</h2><div class="pet-card"><label>角色 <select id="character"><option value="whale">鲸鱼娘</option><option value="corgi">柯基</option></select></label></div><p id="character-status" aria-live="polite"></p><div id="character-error" hidden><p role="alert"></p><button id="character-retry">重试角色</button></div></section><section aria-labelledby="size-heading"><h2 id="size-heading">大小</h2><p>当前大小 <output aria-live="polite"></output></p><div class="presets"><button data-size="70">小</button><button data-size="160">中（默认）</button><button data-size="240">大</button></div><input type="range" aria-label="宠物大小" min="70" max="240" step="10" value="160"><p class="hint">窗口边长，以 DIP 为单位。</p><div class="hidden-notice" hidden>宠物已隐藏 <button id="show">显示宠物</button></div><div class="error" hidden><p role="alert">保存失败，已保留上次保存的大小。</p><button id="retry">重试</button></div></section><section aria-labelledby="login-heading"><h2 id="login-heading">开机启动</h2><label><input id="login-enabled" type="checkbox"> 登录后启动 Mosey</label><p id="login-status" aria-live="polite">正在读取系统状态…</p><p id="login-reason" class="hint" hidden></p><p id="login-error" role="alert" hidden></p><button id="login-cancel" hidden>取消待批准请求</button><button id="login-system" hidden>打开系统设置</button></section></main>`;
let state: Settings;
let operation = 0;
let retired = false;
let communicationFailure: number | undefined;
let dirty = false;
let keyboardCommit: ReturnType<typeof setTimeout> | undefined;
const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
const render = (next: Settings) => {
  if (retired || (state && next.revision < state.revision)) return;
  state = next;
  document.querySelector<HTMLSelectElement>("#character")!.value =
    next.character;
  const names = { whale: "鲸鱼娘", corgi: "柯基" };
  document.querySelector("#character-status")!.textContent =
    next.pendingCharacter
      ? next.pendingCharacter.phase === "loading"
        ? `正在准备${names[next.pendingCharacter.target]}…`
        : `等待宠物站稳后切换为${names[next.pendingCharacter.target]}…`
      : `当前角色：${names[next.character]}`;
  document.querySelector<HTMLElement>("#character-error")!.hidden =
    !next.failedCharacter;
  document.querySelector("#character-error [role=alert]")!.textContent =
    next.failedCharacter
      ? {
          load: "素材加载失败，已保留原角色与选择。",
          save: "保存失败，已保留原角色与上次保存的选择。",
          recovery: "宠物窗口已恢复，角色切换未完成，请重试。",
        }[next.failedCharacter.reason]
      : "";
  communicationFailure = undefined;
  document.querySelector(".error [role=alert]")!.textContent =
    "保存失败，已保留上次保存的大小。";
  if (!dragging && !dirty) slider.value = String(next.size);
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
  render(next);
}
const unsubscribe = window.moseySettings.onChange(receive);
void window.moseySettings.get().then(receive);
const chooseCharacter = async (target: Settings["character"]) => {
  try {
    receive(await window.moseySettings.setCharacter(target));
  } catch {
    if (retired) return;
    document.querySelector<HTMLElement>("#character-error")!.hidden = false;
    document.querySelector("#character-error [role=alert]")!.textContent =
      "无法确认角色切换结果，请重新选择。";
  }
};
document
  .querySelector<HTMLSelectElement>("#character")!
  .addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === "whale" || value === "corgi") void chooseCharacter(value);
  });
document.querySelector("#character-retry")!.addEventListener("click", () => {
  if (state.failedCharacter) void chooseCharacter(state.failedCharacter.target);
});
window.addEventListener(
  "pagehide",
  () => {
    retired = true;
    unsubscribe();
    clearTimeout(keyboardCommit);
  },
  { once: true },
);

attachLoginSettings();
