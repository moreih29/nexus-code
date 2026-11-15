/**
 * This computer's id in the remote account, for what another computer
 * tells of it: a message one of this computer's tabs sent is named as
 * this computer's, not that one's.
 */

import { useEffect, useState } from "react";
import { ipcCallResult, ipcListen } from "../../ipc/client";

let known: string | undefined;

/** This computer's device id; undefined until known, or while signed out. */
export function useSelfDeviceId(): string | undefined {
  const [id, setId] = useState(known);
  useEffect(() => {
    let live = true;
    const take = (state: { status: string; device?: { id: string } }) => {
      known = state.status === "signed-in" ? state.device?.id : undefined;
      if (live) setId(known);
    };
    const off = ipcListen("remote", "accountChanged", take);
    void ipcCallResult("remote", "account", undefined).then((result) => {
      if (result.ok) take(result.value);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return id;
}
