import { type IpcResult, ipcErr } from "../../../shared/ipc/result";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";
import type { CallReturn } from "../../ipc/types";
import type { ChatRef } from "./peer-chat";

const log = createLogger("peer-chat-watch");
type WatchResult = IpcResult<CallReturn<"remote", "peerChatWatch">>;
const watching = new Map<string, Promise<void>>();
export const PEER_CHAT_HANDOFF_MS = 2_000;

async function waitForPrevious(previous: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PEER_CHAT_HANDOFF_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function watchPeerChat(
  ref: ChatRef,
  limit: number | undefined,
  onResult: (result: WatchResult) => void,
): () => void {
  const { deviceId, workspaceId, tabId } = ref;
  const key = JSON.stringify([deviceId, workspaceId, tabId]);
  const released = Promise.withResolvers<void>();
  let live = true;
  const previous = watching.get(key);
  const handoff = previous ? waitForPrevious(previous) : Promise.resolve();
  const task = handoff
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
