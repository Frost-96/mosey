import { useEffect, useRef, useState } from "react";
import type { Settings, SettingsBridge } from "./shared/contract";

const initialLogin: Settings["login"] = {
  status: "unavailable",
  reason: "正在读取系统状态…",
};

// Each effect owns its subscription, revision and in-flight requests. Replaying
// an effect or unmounting retires the entire session, including rejected reads.
export function useLoginSettings(bridge: SettingsBridge) {
  const [view, setView] = useState({ login: initialLogin, busy: false });
  const actions = useRef<
    | {
        setEnabled: (enabled: boolean) => void;
        openSystemSettings: () => void;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    let login = initialLogin;
    let busy = false;
    let revision = -1;
    let retired = false;
    const render = () => {
      if (!retired) setView({ login, busy });
    };
    const receive = (next: Settings) => {
      if (retired || next.revision < revision) return;
      revision = next.revision;
      login = next.login;
      render();
    };
    const run = async (action: () => Promise<Settings>) => {
      if (retired || busy) return;
      busy = true;
      const startedAtRevision = revision;
      render();
      try {
        receive(await action());
      } catch (error) {
        if (!retired && revision === startedAtRevision) {
          login = {
            ...login,
            error: `操作失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      } finally {
        busy = false;
        render();
      }
    };
    const session = {
      setEnabled: (enabled: boolean) =>
        void run(() => bridge.setLoginLaunch(enabled)),
      openSystemSettings: () => void run(() => bridge.openLoginSettings()),
    };
    actions.current = session;
    const unsubscribe = bridge.onChange(receive);
    render();
    void bridge
      .get()
      .then(receive)
      .catch((error) => {
        if (retired || revision !== -1) return;
        login = {
          status: "unavailable",
          reason: `无法读取开机启动状态：${String(error)}`,
        };
        render();
      });
    return () => {
      retired = true;
      unsubscribe();
      if (actions.current === session) actions.current = undefined;
    };
  }, [bridge]);

  return {
    ...view,
    setEnabled: (enabled: boolean) => actions.current?.setEnabled(enabled),
    openSystemSettings: () => actions.current?.openSystemSettings(),
  };
}
