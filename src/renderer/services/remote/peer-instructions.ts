/**
 * Another computer's chat's instructions (chat.instructions), read while
 * its composer shows them, and its session layer set as the user there
 * would (chat.instructions.set, without `from`). The serving device checks
 * chat.read and chat.control itself.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import type { PeerChatRef } from "./peer-mcp";

export type PeerInstructionsRead = RpcResult<"chat.instructions">;

export type PeerInstructionsState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly value: PeerInstructionsRead };

export interface PeerInstructions {
  readonly state: PeerInstructionsState;
  /** Asks again; what was read stays shown meanwhile. */
  refresh(): void;
  /** Replaces the session layer there. Throws where it was not. */
  save(text: string): Promise<void>;
}

/** Reads `ref`'s instructions as it is shown, and again on refresh. */
export function usePeerInstructions(ref: PeerChatRef): PeerInstructions {
  const { deviceId, workspaceId, tabId } = ref;
  const [state, setState] = useState<PeerInstructionsState>({ status: "loading" });
  // Only the last question's answer is taken.
  const asked = useRef(0);

  const refresh = useCallback(() => {
    const n = ++asked.current;
    setState((now) => (now.status === "ready" ? now : { status: "loading" }));
    void ipcCallResult("remote", "peerChatInstructions", { deviceId, workspaceId, tabId }).then(
      (result) => {
        if (n !== asked.current) return;
        setState(result.ok ? { status: "ready", value: result.value } : { status: "failed" });
      },
      () => {
        if (n === asked.current) setState({ status: "failed" });
      },
    );
  }, [deviceId, workspaceId, tabId]);

  useEffect(() => {
    refresh();
    return () => {
      asked.current++;
    };
  }, [refresh]);

  const save = useCallback(
    async (text: string) => {
      const { instructions } = unwrapIpcResult(
        await ipcCallResult("remote", "peerChatInstructionsSet", {
          deviceId,
          workspaceId,
          tabId,
          text,
        }),
      );
      asked.current++;
      // As the serving app keeps it: blank is no session layer.
      const session = text.trim() ? text : "";
      setState((now) =>
        now.status === "ready"
          ? { status: "ready", value: { ...now.value, instructions, session } }
          : now,
      );
    },
    [deviceId, workspaceId, tabId],
  );

  return { state, refresh, save };
}
