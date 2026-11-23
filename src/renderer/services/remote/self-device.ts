import { useEffect, useState } from "react";
import { ipcCallResult, ipcListen } from "../../ipc/client";

let known: string | undefined;

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
