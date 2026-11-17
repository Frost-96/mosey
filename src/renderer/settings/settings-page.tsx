import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Settings } from "../../shared/contract";
import { characterThumbnailUrl } from "../../shared/character-catalog";
import { LoginSettings } from "./settings-login";
import { useSettings } from "./use-settings";

// A failed thumbnail never blocks the choice: the card keeps its name and
// falls back to the name's first character.
function Thumbnail({ id, name }: { id: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span className="thumbnail placeholder" aria-hidden="true">
      {Array.from(name)[0]}
    </span>
  ) : (
    <img
      className="thumbnail"
      src={characterThumbnailUrl(id)}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

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
  const { character, characters, pendingCharacter, failedCharacter } = settings;
  const name = (id: string) =>
    characters.find((entry) => entry.id === id)?.name ?? id;
  const failure =
    error ??
    (failedCharacter &&
      {
        load: "素材加载失败，已保留原角色与选择。",
        save: "保存失败，已保留原角色与上次保存的选择。",
        recovery: "宠物窗口已恢复，角色切换未完成，请重试。",
      }[failedCharacter.reason]);
  return (
    <section aria-labelledby="character-heading">
      <h2 id="character-heading">角色</h2>
      <div className="card">
        <div
          role="radiogroup"
          aria-labelledby="character-heading"
          className="characters"
        >
          {characters.map(({ id, name }) => (
            <label
              key={id}
              className="character"
              data-character={id}
              data-pending={pendingCharacter?.target === id || undefined}
            >
              <input
                className="visually-hidden"
                type="radio"
                name="character"
                value={id}
                checked={id === character}
                // Click, not change: choosing the shown character again
                // cancels a pending switch, as the main process defines.
                // Arrow keys and labels also activate the radio by click.
                readOnly
                onClick={() => setCharacter(id)}
              />
              <Thumbnail id={id} name={name} />
              <span className="name">{name}</span>
              <span className="badge" aria-hidden="true" />
            </label>
          ))}
        </div>
        <p id="character-status" className="status-row" aria-live="polite">
          {pendingCharacter &&
            (pendingCharacter.phase === "loading"
              ? `正在准备${name(pendingCharacter.target)}…`
              : `等待宠物站稳后切换为${name(pendingCharacter.target)}…`)}
        </p>
        <div id="character-error" className="status-row" hidden={!failure}>
          <p role="alert">
            {failure} {failedCharacter?.detail}
          </p>
          <button id="character-retry" aria-label="重试角色" onClick={retry}>
            重试
          </button>
        </div>
      </div>
    </section>
  );
}

function Paw({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="16" rx="6" ry="5" />
      <circle cx="5" cy="9" r="2.5" />
      <circle cx="9.5" cy="5" r="2.5" />
      <circle cx="14.5" cy="5" r="2.5" />
      <circle cx="19" cy="9" r="2.5" />
    </svg>
  );
}

function SizeSettings({
  size,
  busy,
  error,
  preview,
  save,
  retry,
  startGesture,
  finishGesture,
}: {
  size: number;
  busy: boolean;
  error?: string;
  preview(size: number): void;
  save(size: number): void;
  retry(): void;
  startGesture(): void;
  finishGesture(): void;
}) {
  return (
    <section aria-labelledby="size-heading" aria-busy={busy}>
      <h2 id="size-heading">大小</h2>
      <div className="card">
        <div role="group" aria-label="预设大小" className="presets">
          {[
            [70, "小"],
            [160, "中"],
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
        <div className="slider-row">
          <Paw size={12} />
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
          <Paw size={20} />
        </div>
        {/* The number is not shown, but assistive technology still hears it. */}
        <output className="visually-hidden" aria-live="polite">
          {size}
        </output>
        <div className="status-row error" hidden={!error}>
          <p role="alert">{error}</p>
          <button id="retry" onClick={retry}>
            重试
          </button>
        </div>
      </div>
    </section>
  );
}

function SettingsPage() {
  const state = useSettings(window.moseySettings);
  const main = useRef<HTMLElement>(null);
  // The window keeps its width and follows the page's natural height.
  useLayoutEffect(() => {
    const page = main.current!;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(page.getBoundingClientRect().height);
      if (height > 0) window.moseySettings.fitContent(height);
    });
    observer.observe(page);
    return () => observer.disconnect();
  }, []);
  return (
    <main ref={main}>
      <div className="banner-region" role="status">
        {state.settings.visibility === "hidden" && (
          <div className="banner">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 3l18 18" />
              <path d="M6.7 6.7C4.6 8.1 3 10 2 12c2 4 6 7 10 7 1.8 0 3.5-.5 5-1.4" />
              <path d="M10.6 5.1C11 5 11.5 5 12 5c4 0 8 3 10 7-.6 1.2-1.4 2.4-2.4 3.4" />
              <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
            </svg>
            <span>宠物已隐藏</span>
            <button id="show" className="primary" onClick={state.showPet}>
              显示宠物
            </button>
          </div>
        )}
      </div>
      <CharacterSettings
        settings={state.settings}
        error={state.characterError}
        setCharacter={state.setCharacter}
        retry={state.retryCharacter}
      />
      <SizeSettings
        size={state.editSize}
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
