import type { Settings } from "./shared/contract";
import { attachLoginSettings } from "./settings-login";
document.documentElement.dataset.page = "settings";
document.querySelector<HTMLLinkElement>("#settings-style")!.media = "all";
document.title = "Mosey 设置";
document.body.innerHTML = `<main><h1>设置</h1><section aria-labelledby="pet-heading"><h2 id="pet-heading">宠物</h2><div class="pet-card"><span class="pet-mark" aria-hidden="true">🐾</span><div><strong>柯基</strong><p>好奇，又有点懒。</p></div><span class="selected">已选中</span></div></section><section aria-labelledby="size-heading"><h2 id="size-heading">大小</h2><p>当前大小 <output aria-live="polite"></output></p><div class="presets"><button data-size="70">小</button><button data-size="160">中（默认）</button><button data-size="240">大</button></div><p class="hint">窗口边长，以 DIP 为单位。</p><div class="hidden-notice" hidden>宠物已隐藏 <button id="show">显示宠物</button></div><div class="error" hidden><p role="alert">保存失败，已保留上次保存的大小。</p><button id="retry">重试</button></div></section><section aria-labelledby="login-heading"><h2 id="login-heading">开机启动</h2><label><input id="login-enabled" type="checkbox"> 登录后启动 Mosey</label><p id="login-status" aria-live="polite">正在读取系统状态…</p><p id="login-reason" class="hint" hidden></p><p id="login-error" role="alert" hidden></p><button id="login-cancel" hidden>取消待批准请求</button><button id="login-system" hidden>打开系统设置</button></section></main>`;
let state: Settings;
let operation = 0;
const render = (next: Settings) => {
  state = next;
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
const select = async (size: number) => {
  const request = ++operation;
  const result = await window.moseySettings.setSize(size);
  if (request === operation) render(result);
};
document
  .querySelectorAll<HTMLButtonElement>("[data-size]")
  .forEach((button) =>
    button.addEventListener(
      "click",
      () => void select(Number(button.dataset.size)),
    ),
  );
document.querySelector("#retry")!.addEventListener("click", () => {
  if (state.failedSize !== undefined) void select(state.failedSize);
});
document
  .querySelector("#show")!
  .addEventListener(
    "click",
    () => void window.moseySettings.showPet().then(render),
  );
window.moseySettings.onChange(render);
void window.moseySettings.get().then(render);

attachLoginSettings();
