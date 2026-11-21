import { useEffect, useState } from "react";
import type { RemoteAccountState } from "../../../shared/remote/account";
import { ipcCallResult, ipcListen } from "../../ipc/client";

/** The account's state from main, kept up as it changes. */
export function useRemoteAccount(): RemoteAccountState | null {
  const [state, setState] = useState<RemoteAccountState | null>(null);
  useEffect(() => {
    let live = true;
    const off = ipcListen("remote", "accountChanged", (next) => setState(next));
    void ipcCallResult("remote", "account", undefined).then((result) => {
      if (live && result.ok) setState((now) => now ?? result.value);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}
