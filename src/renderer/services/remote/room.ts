// The account's room as main tells it (remote.room, roomChanged): whether
// this device is in, and the account's other devices; and what another
// device serves of its sessions, asked while it is shown.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { IpcResult } from "../../../shared/ipc/result";
import type { RoomPeer, RoomState } from "../../../shared/remote/room";
import { createListenerBus } from "../../../shared/util/listener-bus";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { useRemoteViewStore } from "../../state/stores/remote-view";
import { compareVersions } from "../chat/versions";

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
  // Said on the screen: a drop shorter than DROP_SHOWN_AFTER_MS is not.
  const room = useShownRoom(useRemoteRoom());
  if (!room) return "online";
  if (room.status !== "online") return "disconnected";
  return room.peers.some((p) => p.id === deviceId && p.online) ? "online" : "offline";
}

/**
 * Whether this device may control another's chats: that one serves
 * chat.control, as the user there allowed it. Taken as yes until its hello
 * says otherwise.
 */
export function usePeerControls(deviceId: string, assumeControl = true): boolean {
  const room = useRemoteRoom();
  const serves = room?.peers.find((p) => p.id === deviceId)?.serves;
  return serves?.includes("chat.control") ?? assumeControl;
}

/**
 * Whether another device lets this one read its chats: that one serves
 * chat.read. Taken as yes until its hello says otherwise.
 */
export function usePeerReadsChats(deviceId: string): boolean {
  const room = useRemoteRoom();
  const serves = room?.peers.find((p) => p.id === deviceId)?.serves;
  return serves?.includes("chat.read") ?? true;
}

/**
 * Whether another device lets this one type into its terminals: it serves
 * terminal.control, as the user there allowed it (off unless allowed). No
 * until its hello says.
 */
export function usePeerTypes(deviceId: string): boolean {
  const room = useRemoteRoom();
  const serves = room?.peers.find((p) => p.id === deviceId)?.serves;
  return serves?.includes("terminal.control") ?? false;
}

/**
 * How many times another device joined the room again with a new
 * connection while this one stayed (RoomPeer's `rejoins`): what this one
 * watched there was dropped, so a watch follows it to be asked again.
 */
export function usePeerRejoins(deviceId: string): number {
  const room = useRemoteRoom();
  return room?.peers.find((p) => p.id === deviceId)?.rejoins ?? 0;
}

/**
 * Whether another device, as its hello said, serves `capability`: one the
 * user there allowed (chat.control, terminal.control). No until it said.
 */
export function peerServes(peer: RoomPeer | undefined, capability: string): boolean {
  return peer?.serves?.includes(capability) ?? false;
}

/** The protocol from which terminal.open runs a terminal with a profile's environment. */
export const TERMINAL_PROFILE_SCHEMA = "0.13.1";

/**
 * Whether another device speaks the protocol from `version` on, as its
 * hello's `schema` says. One before it drops what it does not know, as
 * terminal.open's `profile`. No until its hello says.
 */
export function peerSpeaks(peer: RoomPeer | undefined, version: string): boolean {
  return peer?.schema !== undefined && compareVersions(peer.schema, version) >= 0;
}

/**
 * The id there of the profile a chat runs with, of its agent's profiles its
 * computer lists: the one by the chat's profile's name, or, where the chat
 * names none, the agent's only profile (a session names its profile only
 * where its agent has more than one). Throws where neither tells one: a
 * name none or two have, or no name while there are more than one (a list
 * of sessions older than the profiles).
 */
export function chatProfileIdThere(
  name: string | undefined,
  profiles: readonly { id: string; name: string }[],
): string {
  if (name === undefined) {
    const [only, ...more] = profiles;
    if (!only || more.length > 0) throw new Error("this chat's profile is not known here");
    return only.id;
  }
  const named = profiles.filter((p) => p.name === name);
  if (named.length !== 1 || !named[0]) throw new Error(`no one profile "${name}" there`);
  return named[0].id;
}

/** Whether another device speaks the protocol from `version` on. */
export function usePeerSpeaks(deviceId: string, version: string): boolean {
  const room = useRemoteRoom();
  return peerSpeaks(
    room?.peers.find((p) => p.id === deviceId),
    version,
  );
}

/** The devices in the room now that serve their sessions. */
export function servingPeers(room: RoomState | null): RoomPeer[] {
  if (room?.status !== "online") return [];
  return room.peers.filter((p) => p.online && p.serves?.includes("sessions"));
}

/** The systems the desktop app runs on: a phone of the account is not listed when away. */
/**
 * How long a loss stays off the screen: the relay restarting the room drops
 * every device for a second or two, and one back within this was never
 * seen to go. What asks and watches follows the room as it is.
 */
export const DROP_SHOWN_AFTER_MS = 3000;

/** This device, among the losses noted. */
const SELF = "";

/**
 * Notes when this device or another dropped out of the room, from one
 * room to the next: when it went, kept while it stays out; forgotten once
 * it is back.
 */
export function noteDrops(
  prev: RoomState | null,
  next: RoomState | null,
  drops: Map<string, number>,
  now: number,
): void {
  const wasIn = prev?.status === "online";
  const isIn = next?.status === "online";
  if (isIn) drops.delete(SELF);
  else if (wasIn && !drops.has(SELF)) drops.set(SELF, now);
  for (const peer of next?.peers ?? []) {
    if (isIn && peer.online) {
      drops.delete(peer.id);
      continue;
    }
    const was = wasIn && prev?.peers.some((p) => p.id === peer.id && p.online);
    if (was && !drops.has(peer.id)) drops.set(peer.id, now);
  }
}

/**
 * The room as the screen shows it: one that dropped less than
 * DROP_SHOWN_AFTER_MS ago shows in it still, this device while it only
 * connects again. `until` is when the soonest of those shows, to look
 * again then.
 */
export function shownRoom(
  room: RoomState | null,
  drops: ReadonlyMap<string, number>,
  now: number,
): { room: RoomState | null; until?: number } {
  if (!room) return { room };
  let until: number | undefined;
  const fresh = (id: string) => {
    const at = drops.get(id);
    if (at === undefined || now - at >= DROP_SHOWN_AFTER_MS) return false;
    until = Math.min(until ?? Number.POSITIVE_INFINITY, at + DROP_SHOWN_AFTER_MS);
    return true;
  };
  const back = room.status === "connecting" || room.status === "waiting";
  const status = room.status === "online" || (back && fresh(SELF)) ? "online" : room.status;
  if (status !== "online") return { room };
  const peers = room.peers.map((p) => (p.online || !fresh(p.id) ? p : { ...p, online: true }));
  return { room: { status, peers }, ...(until !== undefined ? { until } : {}) };
}

/** The room as useRemoteRoom tells it, shown as shownRoom does: for what the screen says. */
export function useShownRoom(room: RoomState | null): RoomState | null {
  const prev = useRef<RoomState | null>(null);
  const drops = useRef(new Map<string, number>());
  const [, setTick] = useState(0);
  const now = Date.now();
  if (room !== prev.current) {
    noteDrops(prev.current, room, drops.current, now);
    prev.current = room;
  }
  const shown = shownRoom(room, drops.current, now);
  const until = shown.until;
  useEffect(() => {
    if (until === undefined) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, until - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [until]);
  return shown.room;
}

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
  | { status: "ready"; list: SessionsList; requested?: number }
  | { status: "unavailable" };

/** How often a shown device's sessions are asked again, where it cannot be watched. */
export const PEER_POLL_MS = 5000;

/** The lists shown, each told when a device's sessions are to be asked again now. */
const askAgain = createListenerBus<string>();

/**
 * Has the shown lists of `deviceId`'s sessions ask it again now, after this
 * device opened, renamed or closed one there or answered what it waited on:
 * the change shows at once, not with the next poll or watch update.
 */
export function refreshPeerSessions(deviceId: string): void {
  askAgain.notify(deviceId);
}

interface PeerSessionsWatch {
  listeners: ReturnType<typeof createListenerBus<PeerSessions>>;
  latest?: PeerSessions;
  stop: () => void;
}

const sessionWatches = new Map<string, PeerSessionsWatch>();
let sessionsReadSequence = 0;

/** Requests already in flight can predate a session that just opened. */
export function peerSessionsReadSequence(): number {
  return sessionsReadSequence;
}

function watchPeerSessionList(
  deviceId: string,
  put: (list: SessionsList | null, requested?: number) => void,
) {
  let live = true;
  let watching: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let accepted = 0;
  let refreshQueued = false;
  const off = ipcListen("remote", "peerSessionsUpdate", ({ deviceId: from, update }) => {
    if (from !== deviceId || watching !== update.watchId) return;
    const { watchId: _, ...list } = update;
    put(list);
  });
  const read = (list: SessionsList | null, requested: number) => {
    if (requested < accepted) return;
    if (list) accepted = requested;
    put(list, requested);
  };
  const ask = () => {
    const requested = ++sessionsReadSequence;
    void ipcCallResult("remote", "peerSessions", { deviceId }).then((result) => {
      if (live) read(result.ok ? result.value : null, requested);
    });
  };
  const offAgain = askAgain.subscribe((id) => {
    if (id !== deviceId || refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      if (live) ask();
    });
  });
  const unwatch = (watchId: string) =>
    void ipcCallResult("remote", "peerSessionsUnwatch", { deviceId, watchId });
  const requested = ++sessionsReadSequence;
  void ipcCallResult("remote", "peerSessionsWatch", { deviceId }).then((result) => {
    if (!live) {
      if (result.ok) unwatch(result.value.watchId);
      return;
    }
    if (!result.ok) {
      // An older device, or one that did not answer: poll while the list is shown.
      ask();
      timer = setInterval(ask, PEER_POLL_MS);
      return;
    }
    const { watchId, ...list } = result.value;
    watching = watchId;
    read(list, requested);
  });
  return () => {
    live = false;
    off();
    offAgain();
    clearInterval(timer);
    if (watching) unwatch(watching);
  };
}

/** Shares one sessions watch among the sidebar and visible panes on this connection. */
export function observePeerSessions(
  deviceId: string,
  rejoin: number,
  take: (sessions: PeerSessions) => void,
): () => void {
  const key = JSON.stringify([deviceId, rejoin]);
  let watch = sessionWatches.get(key);
  if (!watch) {
    const listeners = createListenerBus<PeerSessions>();
    const next: PeerSessionsWatch = {
      listeners,
      stop: watchPeerSessionList(deviceId, (list, requested) => {
        if (!list && next.latest?.status === "ready") return;
        next.latest = list ? { status: "ready", list, requested } : { status: "unavailable" };
        // Held tabs take up changes even when the sidebar filters out their rows.
        if (list) useRemoteViewStore.getState().refresh(deviceId, list);
        listeners.notify(next.latest);
      }),
    };
    watch = next;
    sessionWatches.set(key, watch);
  }
  const off = watch.listeners.subscribe(take);
  if (watch.latest) take(watch.latest);
  return () => {
    off();
    // A view switch can release the old sidebar before the new one subscribes.
    queueMicrotask(() => {
      if (watch.listeners.size !== 0 || sessionWatches.get(key) !== watch) return;
      sessionWatches.delete(key);
      watch.stop();
    });
  };
}

/** Each visible device's last session list, kept while the next is on its way. */
export function usePeerSessions(
  deviceIds: readonly string[],
  shown: boolean,
): Record<string, PeerSessions> {
  const [lists, setLists] = useState<Record<string, PeerSessions>>({});
  const room = useRemoteRoom();
  const connections = JSON.stringify(
    room?.status === "online"
      ? room.peers
          .filter((peer) => peer.online && deviceIds.includes(peer.id))
          .map((peer) => [peer.id, peer.rejoins ?? 0])
      : [],
  );
  useEffect(() => {
    if (!shown) return;
    const peers = JSON.parse(connections) as [id: string, rejoin: number][];
    const off = peers.map(([id, rejoin]) =>
      observePeerSessions(id, rejoin, (sessions) =>
        setLists((now) => {
          const previous = Object.hasOwn(now, id) ? now[id] : undefined;
          return previous === sessions ||
            (previous?.status === "ready" && sessions.status === "unavailable")
            ? now
            : { ...now, [id]: sessions };
        }),
      ),
    );
    return () => {
      for (const release of off) release();
    };
  }, [connections, shown]);
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
