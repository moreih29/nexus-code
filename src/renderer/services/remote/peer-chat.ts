// A chat of another device as this one watches it (chat.watch): its page
// when the watch begins, kept up with each chat.update. A missing update
// (a rev skipped), the device leaving and coming back (seen to go or not:
// its new connection dropped the watch), the chat hidden and shown again,
// or a watch that fails starts the watch again, which gives the last items
// only: those shown before it stay in front. Earlier ones are read a page
// at a time (chat.read with `before`) when asked for. A slow read now and
// then tells whether the chat is still there, and whether it moved on
// there while no update came: a watch lost unseen, started again.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatPage, ChatPanel } from "../../../../packages/remote-protocol/src";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { applyUpdate, keepEarlier, withEarlier } from "./chat-model";
import { forgetPeerSubmissions, observePeerEchoes } from "./peer-submissions";
import type { PeerRead } from "./room";
import { usePeerRejoins, useRemoteRoom } from "./room";

/** How long after a failed watch it is tried again. */
export const REWATCH_MS = 3000;
/** How often the chat is checked to still be there: a watch says nothing when it is closed. */
export const ALIVE_MS = 15_000;
/**
 * How long the watch is to have said nothing for a chat longer there than
 * here to count as lost: an update on its way is not taken for one.
 */
export const QUIET_MS = 5000;
/** How many items before those shown are read at a time. */
export const EARLIER_ITEMS = 200;

/** A watched chat: its page, and its side panel as the watch last sent it. */
export type WatchedChat = ChatPage & { panel?: ChatPanel };

export interface ChatRef {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}

/** A watched chat, and the reading of the items before those it shows. */
export interface PeerChat {
  read: PeerRead<WatchedChat>;
  /** Reads the items before those shown and puts them in front; again after one that failed. */
  loadEarlier(): void;
  loadingEarlier: boolean;
}

export function usePeerChat(ref: ChatRef, shown: boolean): PeerChat {
  const { deviceId, workspaceId, tabId } = ref;
  const room = useRemoteRoom();
  const online = room?.status === "online" && room.peers.some((p) => p.id === deviceId && p.online);
  // Back in the room with a new connection, seen to go or not: the watch there was dropped.
  const rejoins = usePeerRejoins(deviceId);
  const [read, setRead] = useState<PeerRead<WatchedChat>>({ status: "loading" });
  // Bumped to start the watch again.
  const [round, setRound] = useState(0);
  const watch = useRef<{ id: string; rev: number } | null>(null);
  // When the watch last sent something, or began.
  const heardAt = useRef(0);
  const latest = useRef(read);
  latest.current = read;
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` and `rejoins` start the watch again
  useEffect(() => {
    if (!shown || !online) return;
    const ref = { deviceId, workspaceId, tabId };
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
      heardAt.current = Date.now();
      setRead((now) => {
        if (now.status !== "ready") return now;
        const former = now.value.panel?.session?.id;
        const next = update.panel?.session?.id;
        if (former && update.panel && former !== next) {
          queueMicrotask(again);
          return { status: "loading" };
        }
        const value = applyUpdate(now.value, update);
        // An append with nothing to go on: something was missed.
        if (!value) {
          queueMicrotask(again);
          return now;
        }
        const panel = update.panel ?? now.value.panel;
        if (update.items.length || update.panel) {
          queueMicrotask(() => {
            if (live)
              observePeerEchoes(
                ref,
                update.items,
                update.panel ? (update.panel.held ?? []) : undefined,
              );
          });
        }
        return { status: "ready", value: panel ? { ...value, panel } : value };
      });
    });
    void ipcCallResult("remote", "peerChatWatch", {
      deviceId,
      workspaceId,
      tabId,
      appends: true,
    }).then((result) => {
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
        heardAt.current = Date.now();
        observePeerEchoes(
          ref,
          page.items.map((item, i) => ({ index: page.start + i, item })),
          page.panel?.held ?? [],
        );
        // Watched again, the items shown before stay in front.
        setRead((now) => ({
          status: "ready",
          value: now.status === "ready" ? keepEarlier(now.value, page) : page,
        }));
        return;
      }
      if (result.kind === "not-found") {
        forgetPeerSubmissions(ref);
        setRead({ status: "gone" });
        return;
      }
      setRead((now) =>
        now.status === "ready" ? now : { status: "unavailable", message: result.message },
      );
      retry = setTimeout(again, REWATCH_MS);
    });
    const alive = setInterval(() => {
      void ipcCallResult("remote", "peerChat", { deviceId, workspaceId, tabId, limit: 1 }).then(
        (result) => {
          if (!live) return;
          if (!result.ok) {
            if (result.kind === "not-found") {
              forgetPeerSubmissions(ref);
              setRead({ status: "gone" });
            }
            return;
          }
          // Longer there than here, and the watch quiet: it was lost, as when the device
          // started over unseen; watched again.
          const now = latest.current;
          if (
            watch.current &&
            now.status === "ready" &&
            result.value.total !== now.value.total &&
            Date.now() - heardAt.current > QUIET_MS
          ) {
            again();
          }
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
  }, [deviceId, workspaceId, tabId, shown, online, round, rejoins]);

  const loadEarlier = useCallback(() => {
    const now = latest.current;
    if (loadingEarlier || now.status !== "ready" || now.value.start === 0) return;
    const before = now.value.start;
    const sessionId = now.value.panel?.session?.id;
    setLoadingEarlier(true);
    void ipcCallResult("remote", "peerChat", {
      deviceId,
      workspaceId,
      tabId,
      before,
      limit: EARLIER_ITEMS,
    })
      .then((result) => {
        if (!result.ok) return;
        setRead((was) =>
          was.status === "ready" && was.value.panel?.session?.id === sessionId
            ? { status: "ready", value: withEarlier(was.value, result.value) }
            : was,
        );
      })
      .finally(() => setLoadingEarlier(false));
  }, [deviceId, workspaceId, tabId, loadingEarlier]);

  return {
    read: !online && read.status === "loading" ? { status: "unavailable" } : read,
    loadEarlier,
    loadingEarlier,
  };
}
