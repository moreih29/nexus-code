import { useEffect, useState } from "react";
import type { RemoteAccountState } from "../../../shared/remote/account";
import { ipcCallResult, ipcListen } from "../../ipc/client";

export { remoteAccountKey } from "../../../shared/remote/account";

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

export function useRemoteAccount(): RemoteAccountState | null {
  const [state, setState] = useState<RemoteAccountState | null>(null);
  useEffect(() => observeRemoteAccount(setState), []);
  return state;
}
