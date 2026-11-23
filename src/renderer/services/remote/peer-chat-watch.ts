import type { IpcResult } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";
import type { CallReturn } from "../../ipc/types";
import type { ChatRef } from "./peer-chat";
import { holdPeerWatch, PEER_WATCH_HANDOFF_MS } from "./peer-watch";

type WatchResult = IpcResult<CallReturn<"remote", "peerChatWatch">>;
export const PEER_CHAT_HANDOFF_MS = PEER_WATCH_HANDOFF_MS;

export function watchPeerChat(
  ref: ChatRef,
  limit: number | undefined,
  onResult: (result: WatchResult) => void,
): () => void {
  const { deviceId, workspaceId, tabId } = ref;
  return holdPeerWatch(
    JSON.stringify(["chat", deviceId, workspaceId, tabId]),
    () =>
      ipcCallResult("remote", "peerChatWatch", {
        ...ref,
        appends: true,
        ...(limit !== undefined ? { limit } : {}),
      }),
    (watchId) => ipcCallResult("remote", "peerChatUnwatch", { deviceId, watchId }),
    onResult,
  );
}
