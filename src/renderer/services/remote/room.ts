import i18next from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { IpcResult } from "../../../shared/ipc/result";
import type { RoomPeer, RoomState } from "../../../shared/remote/room";
import { createListenerBus } from "../../../shared/util/listener-bus";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { useRemoteViewStore } from "../../state/stores/remote-view";
import type { PeerSendState } from "../chat/composer-submit";
import { compareVersions } from "../chat/versions";

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

export type PeerReach = "online" | "offline" | "disconnected";

function peerReach(room: RoomState | null, deviceId: string): PeerReach {
  if (!room) return "online";
  if (room.status !== "online") return "disconnected";
  return room.peers.some((p) => p.id === deviceId && p.online) ? "online" : "offline";
}

export function usePeerConnection(
  deviceId: string,
  assumeControl: boolean,
): { reach: PeerReach; controls: boolean } {
  const room = useRemoteRoom();
  const shown = useRoomPresentation(room, deviceId);
  return {
    reach: peerReach(shown.room, deviceId),
    controls: controlsOf(room, deviceId, assumeControl),
  };
}

function controlsOf(room: RoomState | null, deviceId: string, assumeControl: boolean): boolean {
  const serves = room?.peers.find((p) => p.id === deviceId)?.serves;
  return serves?.includes("chat.control") ?? assumeControl;
}

export function usePeerReadsChats(deviceId: string): boolean {
  const room = useRemoteRoom();
  const serves = room?.peers.find((p) => p.id === deviceId)?.serves;
  return serves?.includes("chat.read") ?? true;
}

export function usePeerTypes(deviceId: string): boolean {
  const room = useRemoteRoom();
  const serves = room?.peers.find((p) => p.id === deviceId)?.serves;
  return serves?.includes("terminal.control") ?? false;
}

export function peerRejoins(peer: RoomPeer | undefined): number {
  return peer?.rejoins ?? 0;
}

export function peerServes(peer: RoomPeer | undefined, capability: string): boolean {
  return peer?.serves?.includes(capability) ?? false;
}

export const TERMINAL_PROFILE_SCHEMA = "0.13.1";

export function peerSpeaks(peer: RoomPeer | undefined, version: string): boolean {
  return peer?.schema !== undefined && compareVersions(peer.schema, version) >= 0;
}

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

export function usePeerSpeaks(deviceId: string, version: string): boolean {
  const room = useRemoteRoom();
  return peerSpeaks(
    room?.peers.find((p) => p.id === deviceId),
    version,
  );
}

export function servingPeers(room: RoomState | null): RoomPeer[] {
  if (room?.status !== "online") return [];
  return room.peers.filter((p) => p.online && p.serves?.includes("sessions"));
}

export const DROP_SHOWN_AFTER_MS = 3000;

export function usePeerSendState(ready: boolean): PeerSendState {
  const [state, setState] = useState<PeerSendState>({ ready });
  const until = state.until;
  if (ready !== state.ready) {
    setState(ready ? { ready } : { ready, until: Date.now() + DROP_SHOWN_AFTER_MS });
  }
  useEffect(() => {
    if (until === undefined) return;
    const timer = setTimeout(() => setState({ ready: false }), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);
  return state;
}

const SELF = "";

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

export function shownRoom(
  room: RoomState | null,
  drops: ReadonlyMap<string, number>,
  now: number,
  deviceId?: string,
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
  const peers = room.peers.map((p) =>
    p.online || (deviceId !== undefined && deviceId !== p.id) || !fresh(p.id)
      ? p
      : { ...p, online: true },
  );
  return { room: { status, peers }, ...(until !== undefined ? { until } : {}) };
}

export function useShownRoom(room: RoomState | null): RoomState | null {
  return useRoomPresentation(room).room;
}

function useRoomPresentation(room: RoomState | null, deviceId?: string) {
  const prev = useRef<RoomState | null>(null);
  const drops = useRef(new Map<string, number>());
  const [, setTick] = useState(0);
  const now = Date.now();
  if (room !== prev.current) {
    noteDrops(prev.current, room, drops.current, now);
    prev.current = room;
  }
  const shown = shownRoom(room, drops.current, now, deviceId);
  const until = shown.until;
  useEffect(() => {
    if (until === undefined) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, until - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [until]);
  return shown;
}

const DESKTOPS = new Set(["darwin", "win32", "linux"]);

export function offlinePeers(room: RoomState | null): RoomPeer[] {
  if (room?.status !== "online") return [];
  return room.peers.filter((p) => !p.online && DESKTOPS.has(p.platform));
}

export type SessionsList = RpcResult<"sessions.list">;

export type PeerSessions =
  | { status: "loading" }
  | { status: "ready"; list: SessionsList; requested?: number }
  | { status: "unavailable" };

export const PEER_POLL_MS = 5000;

const askAgain = createListenerBus<string>();

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
        const previous = next.latest?.status === "ready" ? next.latest.list : undefined;
        next.latest = list ? { status: "ready", list, requested } : { status: "unavailable" };
        if (list) {
          const timedOut = list.consentResolutions?.some(
            ({ id, reason }) =>
              reason === "timeout" &&
              previous?.consents?.some((consent) => consent.id === id) &&
              !list.consents?.some((consent) => consent.id === id),
          );
          if (timedOut) {
            showToast({ kind: "info", message: i18next.t("agentView.remote.consentTimeout") });
          }
          useRemoteViewStore.getState().refresh(deviceId, list);
        }
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
    queueMicrotask(() => {
      if (watch.listeners.size !== 0 || sessionWatches.get(key) !== watch) return;
      sessionWatches.delete(key);
      watch.stop();
    });
  };
}

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
          .map((peer) => [peer.id, peerRejoins(peer)])
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

export const PEER_READ_MS = 1500;

export type PeerRead<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "gone" }
  | { status: "unavailable"; message?: string };

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
