import { useCallback, useRef, useState } from "react";
import {
  type ChatPage,
  type ChatPanel,
  MAX_READ_ITEMS,
} from "../../../../packages/remote-protocol/src";
import { ipcCallResult } from "../../ipc/client";
import { applyUpdate, keepEarlier, watchMissedUpdate, withEarlier } from "./chat-model";
import { watchPeerChat } from "./peer-chat-watch";
import { forgetPeerSubmissions, observePeerEchoes } from "./peer-submissions";
import { usePeerWatch } from "./peer-watch";
import type { PeerRead } from "./room";

export const QUIET_MS = 5000;
export const EARLIER_ITEMS = 200;

export type WatchedChat = ChatPage & { panel?: ChatPanel };

export interface ChatRef {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}

export interface PeerChat {
  read: PeerRead<WatchedChat>;
  sendReady: boolean;
  loadEarlier(): void;
  loadingEarlier: boolean;
}

interface ChatWatch {
  id: string;
  rev: number;
  start: number;
}

export function usePeerChat(ref: ChatRef, shown: boolean): PeerChat {
  const { deviceId, workspaceId, tabId } = ref;
  const [read, setRead] = useState<PeerRead<WatchedChat>>({ status: "loading" });
  const recoveryLimit = useRef<number | undefined>(undefined);
  const heardAt = useRef(0);
  const latest = useRef(read);
  latest.current = read;
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const { online, ready } = usePeerWatch<ChatWatch, "peerChatUpdate">({
    deviceId,
    target: JSON.stringify([workspaceId, tabId]),
    shown,
    updates: "peerChatUpdate",
    start(session) {
      const ref = { deviceId, workspaceId, tabId };
      let probing = false;
      const gone = () => {
        forgetPeerSubmissions(ref);
        setRead({ status: "gone" });
      };
      const recovery = recoveryLimit.current;
      recoveryLimit.current = undefined;
      const stop = watchPeerChat(ref, recovery, (result) => {
        if (result.ok) {
          const { watchId, ...page } = result.value;
          session.opened({ id: watchId, rev: 0, start: page.start });
          heardAt.current = Date.now();
          observePeerEchoes(
            ref,
            page.items.map((item, i) => ({ index: page.start + i, item })),
            page.panel?.held ?? [],
          );
          setRead((now) => ({
            status: "ready",
            value: now.status === "ready" ? keepEarlier(now.value, page) : page,
          }));
          return;
        }
        if (result.kind === "not-found") {
          gone();
          return;
        }
        setRead((now) =>
          now.status === "ready" ? now : { status: "unavailable", message: result.message },
        );
        session.retry();
      });
      return {
        update(update, w) {
          heardAt.current = Date.now();
          setRead((now) => {
            if (now.status !== "ready") return now;
            const former = now.value.panel?.session?.id;
            const next = update.panel?.session?.id;
            if (former && update.panel && former !== next) {
              queueMicrotask(session.again);
              return { status: "loading" };
            }
            const value = applyUpdate(now.value, update);
            if (!value) {
              queueMicrotask(session.again);
              return now;
            }
            if (update.total < w.start) w.start = value.start;
            const panel = update.panel ?? now.value.panel;
            if (update.items.length || update.panel) {
              queueMicrotask(() => {
                if (session.live())
                  observePeerEchoes(
                    ref,
                    update.items,
                    update.panel ? (update.panel.held ?? []) : undefined,
                  );
              });
            }
            return { status: "ready", value: panel ? { ...value, panel } : value };
          });
        },
        probe(w) {
          const before = latest.current;
          if (probing || before.status !== "ready" || Date.now() - heardAt.current <= QUIET_MS)
            return;
          const revision = w.rev;
          const limit = Math.max(1, Math.min(MAX_READ_ITEMS, before.value.total - w.start));
          probing = true;
          void ipcCallResult("remote", "peerChat", { deviceId, workspaceId, tabId, limit })
            .then((result) => {
              if (!session.live() || session.current() !== w || w.rev !== revision) return;
              if (!result.ok) {
                if (result.kind === "not-found") gone();
                return;
              }
              if (watchMissedUpdate(before.value, result.value)) {
                recoveryLimit.current = limit;
                session.again();
              }
            })
            .finally(() => {
              probing = false;
            });
        },
        stop,
      };
    },
  });

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
    sendReady: ready && read.status === "ready",
    loadEarlier,
    loadingEarlier,
  };
}
