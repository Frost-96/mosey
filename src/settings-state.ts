import { useEffect, useRef, useState } from "react";
import type { Settings, SettingsBridge } from "./shared/contract";

const initialSettings: Settings = {
  revision: 0,
  character: "whale",
  size: 160,
  visibility: "visible",
  login: { status: "unavailable", reason: "正在读取系统状态…" },
};
type Region = "size" | "login" | "character" | "visibility";
interface View {
  settings: Settings;
  editSize: number;
  sizeBusy: boolean;
  loginBusy: boolean;
  sizeError?: string;
  characterError?: string;
}
interface Actions {
  previewSize(size: number): void;
  saveSize(size: number): void;
  retrySize(): void;
  startGesture(): void;
  finishGesture(): void;
  setCharacter(character: Settings["character"]): void;
  retryCharacter(): void;
  showPet(): void;
  setLoginEnabled(enabled: boolean): void;
  openSystemSettings(): void;
}

// The effect owns a complete page session. Replies only update their region;
// notifications and initial reads reconcile all regions by snapshot revision.
export function useSettings(bridge: SettingsBridge) {
  const [view, setView] = useState<View>({
    settings: initialSettings,
    editSize: 160,
    sizeBusy: false,
    loginBusy: false,
  });
  const actions = useRef<Actions | undefined>(undefined);
  useEffect(() => {
    let settings = initialSettings;
    let editSize = settings.size;
    let dirty = false;
    let dragging = false;
    let retired = false;
    let sizeBusy = false;
    let loginBusy = false;
    let sizeOperation = 0;
    let characterOperation = 0;
    let visibilityOperation = 0;
    let sizeError: string | undefined;
    let sizeReadError: string | undefined;
    let retrySize: number | undefined;
    let characterError: string | undefined;
    let keyboardCommit: ReturnType<typeof setTimeout> | undefined;
    const revisions: Record<Region, number> = {
      size: -1,
      login: -1,
      character: -1,
      visibility: -1,
    };
    const render = () => {
      if (!retired)
        setView({
          settings,
          editSize,
          sizeBusy,
          loginBusy,
          sizeError: sizeError ?? sizeReadError,
          characterError,
        });
    };
    const receive = (next: Settings, region?: Region) => {
      if (retired) return;
      if ((!region || region === "size") && next.revision >= revisions.size) {
        revisions.size = next.revision;
        sizeReadError = undefined;
        settings = {
          ...settings,
          size: next.size,
          failedSize: next.failedSize,
        };
        if (!dirty && !sizeBusy) editSize = next.size;
      }
      if ((!region || region === "login") && next.revision >= revisions.login) {
        revisions.login = next.revision;
        settings = { ...settings, login: next.login };
      }
      if (
        (!region || region === "character") &&
        next.revision >= revisions.character
      ) {
        revisions.character = next.revision;
        characterError = undefined;
        settings = {
          ...settings,
          character: next.character,
          pendingCharacter: next.pendingCharacter,
          failedCharacter: next.failedCharacter,
        };
      }
      if (
        (!region || region === "visibility") &&
        next.revision >= revisions.visibility
      ) {
        revisions.visibility = next.revision;
        settings = { ...settings, visibility: next.visibility };
      }
      render();
    };
    const selectSize = async (size: number, commit: boolean) => {
      const request = ++sizeOperation;
      sizeBusy = true;
      sizeError = undefined;
      retrySize = undefined;
      render();
      try {
        const next = await (commit
          ? bridge.setSize(size)
          : bridge.previewSize(size));
        if (retired || request !== sizeOperation) return;
        receive(next, "size");
      } catch {
        if (retired || request !== sizeOperation) return;
        sizeError = "无法确认保存结果，请重试。";
        retrySize = size;
      } finally {
        if (!retired && request === sizeOperation) {
          sizeBusy = false;
          if (!dirty) editSize = settings.size;
          render();
        }
      }
    };
    const clearCommit = () => {
      clearTimeout(keyboardCommit);
      keyboardCommit = undefined;
    };
    const saveSize = (size: number) => {
      clearCommit();
      dirty = false;
      editSize = size;
      void selectSize(size, true);
    };
    const commitSlider = () => {
      clearCommit();
      if (retired || !dirty) return;
      saveSize(editSize);
    };
    const finishGesture = () => {
      dragging = false;
      commitSlider();
    };
    const runLogin = async (action: () => Promise<Settings>) => {
      if (retired || loginBusy) return;
      loginBusy = true;
      const startedAtRevision = revisions.login;
      render();
      try {
        receive(await action(), "login");
      } catch (error) {
        if (!retired && revisions.login === startedAtRevision) {
          settings = {
            ...settings,
            login: {
              ...settings.login,
              error: `操作失败：${error instanceof Error ? error.message : String(error)}`,
            },
          };
        }
      } finally {
        loginBusy = false;
        render();
      }
    };
    const setCharacter = async (character: Settings["character"]) => {
      const request = ++characterOperation;
      const startedAtRevision = revisions.character;
      characterError = undefined;
      render();
      try {
        const next = await bridge.setCharacter(character);
        if (!retired && request === characterOperation)
          receive(next, "character");
      } catch {
        if (
          !retired &&
          request === characterOperation &&
          revisions.character === startedAtRevision
        ) {
          characterError = "无法确认角色切换结果，请重新选择。";
          render();
        }
      }
    };
    const session: Actions = {
      previewSize(size) {
        dirty = true;
        editSize = size;
        clearCommit();
        void selectSize(size, false);
        if (!dragging) keyboardCommit = setTimeout(commitSlider, 250);
      },
      saveSize,
      retrySize() {
        const target = retrySize ?? settings.failedSize;
        if (target !== undefined) saveSize(target);
      },
      startGesture() {
        dragging = true;
        clearCommit();
      },
      finishGesture,
      setCharacter: (character) => void setCharacter(character),
      retryCharacter() {
        if (settings.failedCharacter)
          void setCharacter(settings.failedCharacter.target);
      },
      async showPet() {
        const request = ++visibilityOperation;
        try {
          const next = await bridge.showPet();
          if (!retired && request === visibilityOperation)
            receive(next, "visibility");
        } catch {
          // A rejected show request leaves the hidden notice and its action
          // available; it cannot be interpreted as a size persistence failure.
        }
      },
      setLoginEnabled: (enabled) =>
        void runLogin(() => bridge.setLoginLaunch(enabled)),
      openSystemSettings: () => void runLogin(() => bridge.openLoginSettings()),
    };
    actions.current = session;
    const unsubscribe = bridge.onChange((next) => receive(next));
    window.addEventListener("pointerup", finishGesture);
    window.addEventListener("blur", finishGesture);
    render();
    void bridge
      .get()
      .then((next) => receive(next))
      .catch((error) => {
        if (retired) return;
        if (revisions.size === -1)
          sizeReadError = "无法读取大小设置，请重新打开设置。";
        if (revisions.login === -1)
          settings = {
            ...settings,
            login: {
              status: "unavailable",
              reason: `无法读取开机启动状态：${String(error)}`,
            },
          };
        render();
      });
    return () => {
      retired = true;
      clearCommit();
      unsubscribe();
      window.removeEventListener("pointerup", finishGesture);
      window.removeEventListener("blur", finishGesture);
      if (actions.current === session) actions.current = undefined;
    };
  }, [bridge]);
  return {
    ...view,
    previewSize: (size: number) => actions.current?.previewSize(size),
    saveSize: (size: number) => actions.current?.saveSize(size),
    retrySize: () => actions.current?.retrySize(),
    startGesture: () => actions.current?.startGesture(),
    finishGesture: () => actions.current?.finishGesture(),
    setCharacter: (character: Settings["character"]) =>
      actions.current?.setCharacter(character),
    retryCharacter: () => actions.current?.retryCharacter(),
    showPet: () => actions.current?.showPet(),
    setLoginEnabled: (enabled: boolean) =>
      actions.current?.setLoginEnabled(enabled),
    openSystemSettings: () => actions.current?.openSystemSettings(),
  };
}
