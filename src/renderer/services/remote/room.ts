// The account's room as main tells it (remote.room, roomChanged): whether
// this device is in, and the account's other devices; and what another
// device serves of its sessions, asked while it is shown.

import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Whether another device of the account can be reached now: "disconnected"
 * while this one is not in the room, "offline" while that one is not.
 * Taken as reachable until main has said.
 */
export type PeerReach = "online" | "offline" | "disconnected";

export function usePeerReach(deviceId: string): PeerReach {
  const room = useRemoteRoom();
  if (!room) return "online";
  if (room.status !== "online") return "disconnected";
  return room.peers.some((p) => p.id === deviceId && p.online) ? "online" : "offline";
}

/**
 * Whether this device may control another's chats: that one serves
 * chat.control, as the user there allowed it. Taken as yes until its hello
 * says otherwise.
 */
export function usePeerControls(deviceId: string): boolean {
  const room = useRemoteRoom();
  const serves = room?.peers.find((p) => p.id === deviceId)?.serves;
  return serves ? serves.includes("chat.control") : true;
}

/** The devices in the room now that serve their sessions. */
export function servingPeers(room: RoomState | null): RoomPeer[] {
  if (room?.status !== "online") return [];
  return room.peers.filter((p) => p.online && p.serves?.includes("sessions"));
}

/** The systems the desktop app runs on: a phone of the account is not listed when away. */
const DESKTOPS = new Set(["darwin", "win32", "linux"]);

/**
 * The account's computers out of the room, listed greyed so the way back
 * to one stays; none while this device is out of it too.
 */
export function offlinePeers(room: RoomState | null): RoomPeer[] {
  if (room?.status !== "online") return [];
  return room.peers.filter((p) => !p.online && DESKTOPS.has(p.platform));
}

export type SessionsList = RpcResult<"sessions.list">;

export type PeerSessions =
  | { status: "loading" }
  | { status: "ready"; list: SessionsList }
  | { status: "unavailable" };

/** How often a shown device's sessions are asked again, where it cannot be watched. */
export const PEER_POLL_MS = 5000;

/**
 * Each device's sessions while `shown`: watched (sessions.watch), the
 * device sending the list as it changes; or, from a device that does not
 * serve the watch, asked now and every PEER_POLL_MS. A device's last list
 * stays while the next is on its way.
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
    const watching = new Map<string, string>();
    const timers: ReturnType<typeof setInterval>[] = [];
    const put = (deviceId: string, list: SessionsList | null) =>
      setLists((now) => ({
        ...now,
        [deviceId]: list
          ? { status: "ready", list }
          : now[deviceId]?.status === "ready"
            ? (now[deviceId] as PeerSessions)
            : { status: "unavailable" },
      }));
    const off = ipcListen("remote", "peerSessionsUpdate", ({ deviceId, update }) => {
      if (!live || watching.get(deviceId) !== update.watchId) return;
      const { watchId: _, ...list } = update;
      put(deviceId, list);
    });
    const poll = (deviceId: string) => {
      const ask = () =>
        void ipcCallResult("remote", "peerSessions", { deviceId }).then((result) => {
          if (live) put(deviceId, result.ok ? result.value : null);
        });
      ask();
      timers.push(setInterval(ask, PEER_POLL_MS));
    };
    for (const deviceId of ids) {
      void ipcCallResult("remote", "peerSessionsWatch", { deviceId }).then((result) => {
        if (!live) {
          if (result.ok) {
            void ipcCallResult("remote", "peerSessionsUnwatch", {
              deviceId,
              watchId: result.value.watchId,
            });
          }
          return;
        }
        if (!result.ok) {
          // A device of an older version, or one that did not answer: asked again and again.
          poll(deviceId);
          return;
        }
        const { watchId, ...list } = result.value;
        watching.set(deviceId, watchId);
        put(deviceId, list);
      });
    }
    return () => {
      live = false;
      off();
      for (const timer of timers) clearInterval(timer);
      for (const [deviceId, watchId] of watching) {
        void ipcCallResult("remote", "peerSessionsUnwatch", { deviceId, watchId });
      }
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
 * from the start when `key` changes; `refresh` reads it at once (after a
 * control, to show its effect). A read that fails keeps the last answer up,
 * unless the session is gone.
 */
export function usePeerRead<T>(
  key: string,
  read: () => Promise<IpcResult<T>>,
  shown: boolean,
): { read: PeerRead<T>; refresh: () => void } {
  const [state, setState] = useState<{ key: string; read: PeerRead<T> }>({
    key,
    read: { status: "loading" },
  });
  const latest = useRef(read);
  latest.current = read;
  const now = useRef<() => void>(() => {});
  useEffect(() => {
    if (!shown) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each read numbered: one that comes back after a later one is dropped.
    let asked = 0;
    let applied = 0;
    const ask = async () => {
      clearTimeout(timer);
      const seq = ++asked;
      const result = await latest.current();
      if (!live || seq < applied) return;
      applied = seq;
      setState((was) => {
        const before = was.key === key ? was.read : ({ status: "loading" } as PeerRead<T>);
        const next: PeerRead<T> = result.ok
          ? { status: "ready", value: result.value }
          : result.kind === "not-found"
            ? { status: "gone" }
            : before.status === "ready"
              ? before
              : { status: "unavailable", message: result.message };
        return { key, read: next };
      });
      if (seq === asked) timer = setTimeout(() => void ask(), PEER_READ_MS);
    };
    now.current = () => void ask();
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
      now.current = () => {};
    };
  }, [key, shown]);
  const refresh = useCallback(() => now.current(), []);
  return { read: state.key === key ? state.read : { status: "loading" }, refresh };
}
