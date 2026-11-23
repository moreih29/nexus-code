import { useEffect, useRef, useState } from "react";
import type { TerminalCaret } from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/renderer";
import type { RoomState } from "../../../shared/remote/room";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../ipc/client";
import { ALIVE_MS, REWATCH_MS } from "./peer-chat";
import { PEER_READ_MS, type PeerRead, useRemoteRoom } from "./room";
import { TerminalTyping } from "./terminal-typing";
import { applyTextChange } from "./terminal-watch";

const log = createLogger("peer-terminal");

export interface TerminalRef {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}

export function watchPeerTerminalTyping(
  target: TerminalRef,
  onTyping: (typing: TerminalTyping | null) => void,
  onFailure: (error: unknown) => void,
): () => void {
  let live = true;
  let heardRoom = false;
  let connection: number | undefined;
  let typing: TerminalTyping | null = null;

  const applyRoom = (room: RoomState) => {
    const peer = room.peers.find(({ id }) => id === target.deviceId);
    const next =
      room.status === "online" && peer?.online && peer.serves?.includes("terminal.control")
        ? (peer.rejoins ?? 0)
        : undefined;
    if (next === connection) return;

    const discarded = typing?.dispose();
    connection = next;
    typing =
      next === undefined
        ? null
        : new TerminalTyping(async (input) => {
            unwrapIpcResult(
              await ipcCallResult("remote", "peerTerminalInput", { ...target, ...input }),
            );
          }, onFailure);
    onTyping(typing);
    if (discarded) onFailure(new Error("Remote terminal connection changed with input waiting"));
  };

  const off = ipcListen("remote", "roomChanged", (room) => {
    if (!live) return;
    heardRoom = true;
    applyRoom(room);
  });
  void ipcCallResult("remote", "room", undefined)
    .then((result) => {
      if (!live || heardRoom) return;
      if (result.ok) applyRoom(result.value);
      else log.warn(`Remote terminal room snapshot failed: ${result.message}`);
    })
    .catch((error: unknown) => {
      if (live && !heardRoom) log.warn(`Remote terminal room snapshot failed: ${String(error)}`);
    });

  return () => {
    live = false;
    off();
    typing?.dispose();
  };
}

export interface PeerScreen {
  text: string;
  caret?: TerminalCaret;
}

function screenOf(text: string, caret: TerminalCaret | undefined): PeerScreen {
  return caret ? { text, caret } : { text };
}

export function usePeerTerminal(
  ref: TerminalRef,
  lines: number,
  shown: boolean,
): PeerRead<PeerScreen> {
  const { deviceId, workspaceId, tabId } = ref;
  const room = useRemoteRoom();
  const online = room?.status === "online" && room.peers.some((p) => p.id === deviceId && p.online);
  const rejoins = room?.peers.find((p) => p.id === deviceId)?.rejoins ?? 0;
  const [read, setRead] = useState<PeerRead<PeerScreen>>({ status: "loading" });
  const [round, setRound] = useState(0);
  const watch = useRef<{ id: string; rev: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` and `rejoins` start the watch again
  useEffect(() => {
    if (!shown || !online) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const target = { deviceId, workspaceId, tabId };
    const again = () => {
      if (live) setRound((r) => r + 1);
    };
    const failed = (result: { kind: string; message?: string }) => {
      if (result.kind === "not-found") {
        setRead({ status: "gone" });
        return true;
      }
      setRead((now) =>
        now.status === "ready" ? now : { status: "unavailable", message: result.message },
      );
      return false;
    };
    const readAgain = () => {
      void ipcCallResult("remote", "peerTerminal", { ...target, lines, ansi: true }).then(
        (result) => {
          if (!live) return;
          if (result.ok) {
            setRead({ status: "ready", value: screenOf(result.value.text, result.value.caret) });
          } else if (failed(result)) return;
          poll = setTimeout(readAgain, PEER_READ_MS);
        },
      );
    };
    const off = ipcListen("remote", "peerTerminalUpdate", ({ deviceId: from, update }) => {
      const w = watch.current;
      if (!live || from !== deviceId || !w || update.watchId !== w.id) return;
      if (update.rev !== w.rev + 1) {
        again();
        return;
      }
      w.rev = update.rev;
      setRead((now) =>
        now.status === "ready"
          ? {
              status: "ready",
              value: screenOf(applyTextChange(now.value.text, update), update.caret),
            }
          : now,
      );
    });
    void ipcCallResult("remote", "peerTerminalWatch", { ...target, lines, ansi: true }).then(
      (result) => {
        if (!live) {
          if (result.ok) {
            void ipcCallResult("remote", "peerTerminalUnwatch", {
              deviceId,
              watchId: result.value.watchId,
            });
          }
          return;
        }
        if (result.ok) {
          watch.current = { id: result.value.watchId, rev: 0 };
          setRead({ status: "ready", value: screenOf(result.value.text, result.value.caret) });
          return;
        }
        if (failed(result)) return;
        if (result.kind === "unsupported") readAgain();
        else retry = setTimeout(again, REWATCH_MS);
      },
    );
    const alive = setInterval(() => {
      if (!watch.current) return;
      void ipcCallResult("remote", "peerTerminal", { ...target, lines: 1 }).then((result) => {
        if (live && !result.ok && result.kind === "not-found") setRead({ status: "gone" });
      });
    }, ALIVE_MS);
    return () => {
      live = false;
      off();
      clearTimeout(retry);
      clearTimeout(poll);
      clearInterval(alive);
      const w = watch.current;
      watch.current = null;
      if (w) void ipcCallResult("remote", "peerTerminalUnwatch", { deviceId, watchId: w.id });
    };
  }, [deviceId, workspaceId, tabId, lines, shown, online, round, rejoins]);

  if (!online && read.status === "loading") return { status: "unavailable" };
  return read;
}
