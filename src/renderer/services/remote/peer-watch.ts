import { useEffect, useRef, useState } from "react";
import { type IpcResult, ipcErr } from "../../../shared/ipc/result";
import { createLogger } from "../../../shared/log/renderer";
import { ipcListen } from "../../ipc/client";
import type { ListenArg } from "../../ipc/types";
import { peerRejoins, useRemoteRoom } from "./room";

const log = createLogger("peer-watch");

export const REWATCH_MS = 3000;
export const ALIVE_MS = 15_000;
export const PEER_WATCH_HANDOFF_MS = 2_000;

const holding = new Map<string, Promise<void>>();

async function waitForPrevious(previous: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PEER_WATCH_HANDOFF_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function holdPeerWatch<T extends { watchId: string }>(
  key: string,
  open: () => Promise<IpcResult<T>>,
  unwatch: (watchId: string) => Promise<unknown>,
  onResult: (result: IpcResult<T>) => void,
): () => void {
  const released = Promise.withResolvers<void>();
  let live = true;
  const previous = holding.get(key);
  const handoff = previous ? waitForPrevious(previous) : Promise.resolve();
  const task = handoff
    .then(async () => {
      if (!live) return;
      let result: IpcResult<T>;
      try {
        result = await open();
      } catch (error) {
        result = ipcErr("unavailable", String(error));
      }
      try {
        if (live) onResult(result);
        if (live && result.ok) await released.promise;
      } finally {
        if (result.ok) await unwatch(result.value.watchId);
      }
    })
    .catch((error: unknown) => log.warn(String(error)))
    .finally(() => {
      if (holding.get(key) === task) holding.delete(key);
    });
  holding.set(key, task);
  return () => {
    live = false;
    released.resolve();
  };
}

export interface PeerOnline {
  online: boolean;
  rejoins: number;
}

export function usePeerOnline(deviceId: string): PeerOnline {
  const room = useRemoteRoom();
  const peer = room?.peers.find((p) => p.id === deviceId);
  return {
    online: room?.status === "online" && peer?.online === true,
    rejoins: peerRejoins(peer),
  };
}

export interface PeerWatched {
  id: string;
  rev: number;
}

export type PeerUpdateEvent = "peerChatUpdate" | "peerTerminalUpdate";
export type PeerUpdate<E extends PeerUpdateEvent> = ListenArg<"remote", E>["update"];

export interface PeerWatchSession<W extends PeerWatched> {
  current(): W | null;
  live(): boolean;
  opened(watch: W): void;
  again(): void;
  retry(): void;
}

export interface PeerWatchRun<W extends PeerWatched, E extends PeerUpdateEvent> {
  update(update: PeerUpdate<E>, watch: W): void;
  probe(watch: W): void;
  stop(): void;
}

export interface PeerWatchOptions<W extends PeerWatched, E extends PeerUpdateEvent> {
  deviceId: string;
  target: string;
  shown: boolean;
  updates: E;
  start(session: PeerWatchSession<W>): PeerWatchRun<W, E>;
}

export function usePeerWatch<W extends PeerWatched, E extends PeerUpdateEvent>(
  options: PeerWatchOptions<W, E>,
): boolean {
  const { deviceId, target, shown } = options;
  const { online, rejoins } = usePeerOnline(deviceId);
  const [round, setRound] = useState(0);
  const watch = useRef<W | null>(null);
  const latest = useRef(options);
  latest.current = options;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `target`, `round` and `rejoins` start the watch again
  useEffect(() => {
    if (!shown || !online) return;
    const { updates, start } = latest.current;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const session: PeerWatchSession<W> = {
      current: () => watch.current,
      live: () => live,
      opened: (next) => {
        watch.current = next;
      },
      again: () => {
        if (live) setRound((r) => r + 1);
      },
      retry: () => {
        clearTimeout(retry);
        retry = setTimeout(session.again, REWATCH_MS);
      },
    };
    const run = start(session);
    const off = ipcListen(
      "remote",
      updates,
      (event: { deviceId: string; update: PeerUpdate<E> }) => {
        const w = watch.current;
        const { update } = event;
        if (!live || event.deviceId !== deviceId || !w || update.watchId !== w.id) return;
        if (update.rev !== w.rev + 1) {
          session.again();
          return;
        }
        w.rev = update.rev;
        run.update(update, w);
      },
    );
    const alive = setInterval(() => {
      const w = watch.current;
      if (w) run.probe(w);
    }, ALIVE_MS);
    return () => {
      live = false;
      off();
      clearTimeout(retry);
      clearInterval(alive);
      watch.current = null;
      run.stop();
    };
  }, [deviceId, target, shown, online, round, rejoins]);

  return online;
}
