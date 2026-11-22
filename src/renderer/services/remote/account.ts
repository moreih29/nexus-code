import { useEffect, useState } from "react";
import type { RemoteAccountState } from "../../../shared/remote/account";
import { ipcCallResult, ipcListen } from "../../ipc/client";

/** Identifies a signed-in account on its server. */
export function remoteAccountKey(state: RemoteAccountState | null): string | null {
  return state?.status === "signed-in" ? JSON.stringify([state.server, state.user.id]) : null;
}

/** Reads the current account and listens for changes, which supersede the initial reply. */
export function observeRemoteAccount(take: (state: RemoteAccountState) => void): () => void {
  let useInitialReply = true;
  const off = ipcListen("remote", "accountChanged", (state) => {
    useInitialReply = false;
    take(state);
  });
  void ipcCallResult("remote", "account", undefined)
    .then((result) => {
      if (useInitialReply && result.ok) take(result.value);
    })
    .catch(() => {});
  return () => {
    useInitialReply = false;
    off();
  };
}

/** The account's state from main, kept up as it changes. */
export function useRemoteAccount(): RemoteAccountState | null {
  const [state, setState] = useState<RemoteAccountState | null>(null);
  useEffect(() => observeRemoteAccount(setState), []);
  return state;
}
