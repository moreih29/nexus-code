// The account's room as main tells it (remote.room, roomChanged): whether
// this device is in, and the account's other devices; and what another
// device serves of its sessions, asked while it is shown.

import { useEffect, useRef, useState } from "react";
import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { IpcResult } from "../../../shared/ipc/result";
import type { RoomPeer, RoomState } from "../../../shared/remote/room";
import { ipcCallResult, ipcListen } from "../../ipc/client";

/** The room, kept up as it changes; null until main answered. */
export function useRemoteRoom(): RoomState | null {
  const [state, setState] = useState<RoomState | null>(null);
  useEffect(() => {
    let live = true;
    const off = ipcListen("remote", "roomChanged", (next) => setState(next));
    void ipcCallResult("remote", "room", undefined).then((result) => {
      if (live && result.ok) setState((now) => now ?? result.value);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** The devices in the room now that serve their sessions. */
export function servingPeers(room: RoomState | null): RoomPeer[] {
  if (room?.status !== "online") return [];
  return room.peers.filter((p) => p.online && p.serves?.includes("sessions"));
}

export type SessionsList = RpcResult<"sessions.list">;

export type PeerSessions =
  | { status: "loading" }
  | { status: "ready"; list: SessionsList }
  | { status: "unavailable" };

/** How often a shown device's sessions are asked again. */
export const PEER_POLL_MS = 5000;

/**
 * Each device's sessions, asked now and every PEER_POLL_MS while `shown`;
 * a device's last list stays while the next is on its way.
 */
export function usePeerSessions(
  deviceIds: readonly string[],
  shown: boolean,
): Record<string, PeerSessions> {
  const [lists, setLists] = useState<Record<string, PeerSessions>>({});
  const key = deviceIds.join("|");
  useEffect(() => {
    if (!shown || key === "") return;
    const ids = key.split("|");
    let live = true;
    const ask = () => {
      for (const deviceId of ids) {
        void ipcCallResult("remote", "peerSessions", { deviceId }).then((result) => {
          if (!live) return;
          setLists((now) => ({
            ...now,
            [deviceId]: result.ok
              ? { status: "ready", list: result.value }
              : now[deviceId]?.status === "ready"
                ? (now[deviceId] as PeerSessions)
                : { status: "unavailable" },
          }));
        });
      }
    };
    ask();
    const timer = setInterval(ask, PEER_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [key, shown]);
  return lists;
}

/** How often a shown chat or terminal of another device is read again. */
export const PEER_READ_MS = 1500;

export type PeerRead<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  /** The session is no longer there: closed, or its workspace removed. */
  | { status: "gone" }
  | { status: "unavailable"; message?: string };

/**
 * What `read` answers, read now and every PEER_READ_MS while `shown`, again
 * from the start when `key` changes. A read that fails keeps the last answer
 * up, unless the session is gone.
 */
export function usePeerRead<T>(
  key: string,
  read: () => Promise<IpcResult<T>>,
  shown: boolean,
): PeerRead<T> {
  const [state, setState] = useState<{ key: string; read: PeerRead<T> }>({
    key,
    read: { status: "loading" },
  });
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    if (!shown) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const result = await latest.current();
      if (!live) return;
      setState((now) => {
        const was = now.key === key ? now.read : ({ status: "loading" } as PeerRead<T>);
        const next: PeerRead<T> = result.ok
          ? { status: "ready", value: result.value }
          : result.kind === "not-found"
            ? { status: "gone" }
            : was.status === "ready"
              ? was
              : { status: "unavailable", message: result.message };
        return { key, read: next };
      });
      timer = setTimeout(() => void ask(), PEER_READ_MS);
    };
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, shown]);
  return state.key === key ? state.read : { status: "loading" };
}
