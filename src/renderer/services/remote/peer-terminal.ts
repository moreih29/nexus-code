// A terminal of another device as this one watches it (terminal.watch):
// its text when the watch begins, kept up with each terminal.update. A
// missing update (a rev skipped), the device leaving and coming back, or a
// watch that fails starts the watch again; a slow read now and then tells
// whether the terminal is still there. A device that does not serve the
// watch (an older version) is read again and again instead.

import { useEffect, useRef, useState } from "react";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { ALIVE_MS, REWATCH_MS } from "./peer-chat";
import { PEER_READ_MS, type PeerRead, useRemoteRoom } from "./room";
import { applyTextChange } from "./terminal-watch";

export interface TerminalRef {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}

export function usePeerTerminal(
  ref: TerminalRef,
  lines: number,
  shown: boolean,
): PeerRead<{ text: string }> {
  const { deviceId, workspaceId, tabId } = ref;
  const room = useRemoteRoom();
  const online = room?.status === "online" && room.peers.some((p) => p.id === deviceId && p.online);
  const [read, setRead] = useState<PeerRead<{ text: string }>>({ status: "loading" });
  // Bumped to start the watch again.
  const [round, setRound] = useState(0);
  const watch = useRef<{ id: string; rev: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` starts the watch again
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
      void ipcCallResult("remote", "peerTerminal", { ...target, lines }).then((result) => {
        if (!live) return;
        if (result.ok) setRead({ status: "ready", value: result.value });
        else if (failed(result)) return;
        poll = setTimeout(readAgain, PEER_READ_MS);
      });
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
          ? { status: "ready", value: { text: applyTextChange(now.value.text, update) } }
          : now,
      );
    });
    void ipcCallResult("remote", "peerTerminalWatch", { ...target, lines }).then((result) => {
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
        setRead({ status: "ready", value: { text: result.value.text } });
        return;
      }
      if (failed(result)) return;
      // Not served there (an older version): read instead. Anything else: watched again soon.
      if (result.kind === "unsupported") readAgain();
      else retry = setTimeout(again, REWATCH_MS);
    });
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
  }, [deviceId, workspaceId, tabId, lines, shown, online, round]);

  if (!online && read.status === "loading") return { status: "unavailable" };
  return read;
}
