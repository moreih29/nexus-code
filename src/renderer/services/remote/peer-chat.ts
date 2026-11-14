// A chat of another device as this one watches it (chat.watch): its page
// when the watch begins, kept up with each chat.update. A missing update
// (a rev skipped), the device leaving and coming back, or a watch that
// fails starts the watch again; a slow read now and then tells whether
// the chat is still there.

import { useEffect, useRef, useState } from "react";
import type { ChatPage } from "../../../../packages/remote-protocol/src";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { applyUpdate } from "./chat-model";
import type { PeerRead } from "./room";
import { useRemoteRoom } from "./room";

/** How long after a failed watch it is tried again. */
export const REWATCH_MS = 3000;
/** How often the chat is checked to still be there: a watch says nothing when it is closed. */
export const ALIVE_MS = 15_000;

export interface ChatRef {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}

export function usePeerChat(ref: ChatRef, shown: boolean): PeerRead<ChatPage> {
  const { deviceId, workspaceId, tabId } = ref;
  const room = useRemoteRoom();
  const online = room?.status === "online" && room.peers.some((p) => p.id === deviceId && p.online);
  const [read, setRead] = useState<PeerRead<ChatPage>>({ status: "loading" });
  // Bumped to start the watch again.
  const [round, setRound] = useState(0);
  const watch = useRef<{ id: string; rev: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` starts the watch again
  useEffect(() => {
    if (!shown || !online) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      if (live) setRound((r) => r + 1);
    };
    const off = ipcListen("remote", "peerChatUpdate", ({ deviceId: from, update }) => {
      const w = watch.current;
      if (!live || from !== deviceId || !w || update.watchId !== w.id) return;
      if (update.rev !== w.rev + 1) {
        again();
        return;
      }
      w.rev = update.rev;
      setRead((now) =>
        now.status === "ready" ? { status: "ready", value: applyUpdate(now.value, update) } : now,
      );
    });
    void ipcCallResult("remote", "peerChatWatch", { deviceId, workspaceId, tabId }).then(
      (result) => {
        if (!live) {
          if (result.ok) {
            void ipcCallResult("remote", "peerChatUnwatch", {
              deviceId,
              watchId: result.value.watchId,
            });
          }
          return;
        }
        if (result.ok) {
          const { watchId, ...page } = result.value;
          watch.current = { id: watchId, rev: 0 };
          setRead({ status: "ready", value: page });
          return;
        }
        if (result.kind === "not-found") {
          setRead({ status: "gone" });
          return;
        }
        setRead((now) =>
          now.status === "ready" ? now : { status: "unavailable", message: result.message },
        );
        retry = setTimeout(again, REWATCH_MS);
      },
    );
    const alive = setInterval(() => {
      void ipcCallResult("remote", "peerChat", { deviceId, workspaceId, tabId, limit: 1 }).then(
        (result) => {
          if (live && !result.ok && result.kind === "not-found") setRead({ status: "gone" });
        },
      );
    }, ALIVE_MS);
    return () => {
      live = false;
      off();
      clearTimeout(retry);
      clearInterval(alive);
      const w = watch.current;
      watch.current = null;
      if (w) void ipcCallResult("remote", "peerChatUnwatch", { deviceId, watchId: w.id });
    };
  }, [deviceId, workspaceId, tabId, shown, online, round]);

  if (!online && read.status === "loading") return { status: "unavailable" };
  return read;
}
