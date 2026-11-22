import { type IpcResult, ipcErr } from "../../../shared/ipc/result";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";
import type { CallReturn } from "../../ipc/types";
import type { ChatRef } from "./peer-chat";

const log = createLogger("peer-chat-watch");
type WatchResult = IpcResult<CallReturn<"remote", "peerChatWatch">>;
const watching = new Map<string, Promise<void>>();

/** Wait for the old remote watch to finish closing when a chat changes views. */
export function watchPeerChat(
  ref: ChatRef,
  limit: number | undefined,
  onResult: (result: WatchResult) => void,
): () => void {
  const { deviceId, workspaceId, tabId } = ref;
  const key = JSON.stringify([deviceId, workspaceId, tabId]);
  const released = Promise.withResolvers<void>();
  let live = true;
  const previous = watching.get(key) ?? Promise.resolve();
  const task = previous
    .then(async () => {
      if (!live) return;
      let result: WatchResult;
      try {
        result = await ipcCallResult("remote", "peerChatWatch", {
          ...ref,
          appends: true,
          ...(limit !== undefined ? { limit } : {}),
        });
      } catch (error) {
        result = ipcErr("unavailable", String(error));
      }
      try {
        if (live) onResult(result);
        if (live && result.ok) await released.promise;
      } finally {
        if (result.ok) {
          await ipcCallResult("remote", "peerChatUnwatch", {
            deviceId,
            watchId: result.value.watchId,
          });
        }
      }
    })
    .catch((error: unknown) => log.warn(String(error)))
    .finally(() => {
      if (watching.get(key) === task) watching.delete(key);
    });
  watching.set(key, task);
  return () => {
    live = false;
    released.resolve();
  };
}
