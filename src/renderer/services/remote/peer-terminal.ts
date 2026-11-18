// A terminal of another device as this one watches it (terminal.watch):
// its text when the watch begins, with its colors and styles as SGR escapes
// (`ansi`; a device that keeps them back sends plain text) and its cursor
// (where that device tells it), kept up with each terminal.update. A
// missing update (a rev skipped), the device leaving and coming back (seen
// to go or not: its new connection dropped the watch), or a watch that
// fails starts the watch again; a slow read now and then tells
// whether the terminal is still there. A device that does not serve the
// watch (an older version) is read again and again instead.

import { useEffect, useRef, useState } from "react";
import type { TerminalCaret } from "../../../../packages/remote-protocol/src";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { ALIVE_MS, REWATCH_MS } from "./peer-chat";
import { PEER_READ_MS, type PeerRead, useRemoteRoom } from "./room";
import { applyTextChange } from "./terminal-watch";

export interface TerminalRef {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}

/** A terminal's text, and its cursor where its device tells it and it shows. */
export interface PeerScreen {
  text: string;
  caret?: TerminalCaret;
}

/** The screen from a read, a watch's start or an update: the cursor as it says, none if not. */
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
  // Back in the room with a new connection, seen to go or not: the watch there was dropped.
  const rejoins = room?.peers.find((p) => p.id === deviceId)?.rejoins ?? 0;
  const [read, setRead] = useState<PeerRead<PeerScreen>>({ status: "loading" });
  // Bumped to start the watch again.
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
    // An older device: its text read now and every PEER_READ_MS.
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
        // Not served there (an older version): read instead. Anything else: watched again soon.
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
