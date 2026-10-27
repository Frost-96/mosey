import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Settings } from "./shared/contract";
import { LoginSettings } from "./settings-login";
import { useSettings } from "./settings-state";

const characterNames = { whale: "鲸鱼娘", corgi: "柯基" };
function CharacterSettings({
  settings,
  error,
  setCharacter,
  retry,
}: {
  settings: Settings;
  error?: string;
  setCharacter(character: Settings["character"]): void;
  retry(): void;
}) {
  const { character, pendingCharacter, failedCharacter } = settings;
  const failure =
    error ??
    (failedCharacter &&
      {
        load: "素材加载失败，已保留原角色与选择。",
        save: "保存失败，已保留原角色与上次保存的选择。",
        recovery: "宠物窗口已恢复，角色切换未完成，请重试。",
      }[failedCharacter.reason]);
  return (
    <section aria-labelledby="pet-heading">
      <h2 id="pet-heading">宠物</h2>
      <div className="pet-card">
        <label>
          角色{" "}
          <select
            id="character"
            value={character}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "whale" || value === "corgi") setCharacter(value);
            }}
          >
            <option value="whale">鲸鱼娘</option>
            <option value="corgi">柯基</option>
          </select>
        </label>
      </div>
      <p id="character-status" aria-live="polite">
        {pendingCharacter
          ? pendingCharacter.phase === "loading"
            ? `正在准备${characterNames[pendingCharacter.target]}…`
            : `等待宠物站稳后切换为${characterNames[pendingCharacter.target]}…`
          : `当前角色：${characterNames[character]}`}
      </p>
      <div id="character-error" hidden={!failure}>
        <p role="alert">{failure}</p>
        <button id="character-retry" onClick={retry}>
          重试角色
        </button>
      </div>
    </section>
  );
}

function SizeSettings({
  size,
  hidden,
  busy,
  error,
  preview,
  save,
  retry,
  show,
  startGesture,
  finishGesture,
}: {
  size: number;
  hidden: boolean;
  busy: boolean;
  error?: string;
  preview(size: number): void;
  save(size: number): void;
  retry(): void;
  show(): void;
  startGesture(): void;
  finishGesture(): void;
}) {
  return (
    <section aria-labelledby="size-heading" aria-busy={busy}>
      <h2 id="size-heading">大小</h2>
      <p>
        当前大小 <output aria-live="polite">{size}</output>
      </p>
      <div className="presets">
        {[
          [70, "小"],
          [160, "中（默认）"],
          [240, "大"],
        ].map(([value, label]) => (
          <button
            key={value}
            data-size={value}
            aria-pressed={size === value}
            onClick={() => save(Number(value))}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        type="range"
        aria-label="宠物大小"
        min="70"
        max="240"
        step="10"
        value={size}
        onInput={(event) => preview(Number(event.currentTarget.value))}
        onPointerDown={startGesture}
        onPointerCancel={finishGesture}
        onLostPointerCapture={finishGesture}
        onBlur={finishGesture}
      />
      <p className="hint">窗口边长，以 DIP 为单位。</p>
      <div className="hidden-notice" hidden={!hidden}>
        宠物已隐藏{" "}
        <button id="show" onClick={show}>
          显示宠物
        </button>
      </div>
      <div className="error" hidden={!error}>
        <p role="alert">{error}</p>
        <button id="retry" onClick={retry}>
          重试
        </button>
      </div>
    </section>
  );
}

function SettingsPage() {
  const state = useSettings(window.moseySettings);
  return (
    <main>
      <h1>设置</h1>
      <CharacterSettings
        settings={state.settings}
        error={state.characterError}
        setCharacter={state.setCharacter}
        retry={state.retryCharacter}
      />
      <SizeSettings
        size={state.editSize}
        hidden={state.settings.visibility === "hidden"}
        busy={state.sizeBusy}
        error={
          state.sizeError ??
          (state.settings.failedSize === undefined
            ? undefined
            : "保存失败，已保留上次保存的大小。")
        }
        preview={state.previewSize}
        save={state.saveSize}
        retry={state.retrySize}
        show={state.showPet}
        startGesture={state.startGesture}
        finishGesture={state.finishGesture}
      />
      <LoginSettings
        login={state.settings.login}
        busy={state.loginBusy}
        setEnabled={state.setLoginEnabled}
        openSystemSettings={state.openSystemSettings}
      />
    </main>
  );
}

const mounts = new WeakMap<HTMLElement, () => void>();
export function attachSettingsPage(host: HTMLElement) {
  mounts.get(host)?.();
  const root = createRoot(host);
  root.render(
    <StrictMode>
      <SettingsPage />
    </StrictMode>,
  );
  const dispose = () => {
    if (mounts.get(host) !== dispose) return;
    mounts.delete(host);
    window.removeEventListener("pagehide", dispose);
    root.unmount();
  };
  mounts.set(host, dispose);
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
