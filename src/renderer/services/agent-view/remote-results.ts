import { useEffect, useState, useSyncExternalStore } from "react";
import type { RemoteSession, RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { RoomPeer } from "../../../shared/remote/room";
import { createListenerBus } from "../../../shared/util/listener-bus";
import { ipcCallResult } from "../../ipc/client";
import { observePeerSessions } from "../remote/room";
import { remoteSessionKey } from "./layout";

type EventPage = RpcResult<"events.read">;
type ResultState = { at: number; outcome?: "completed" | "error" };

const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const READ_INTERVAL_MS = 4000;

/** Viewing or clearing an outcome affects this account's sidebar on this device only. */
export class RemoteResults {
  private readonly changes = createListenerBus();
  private readonly history = new Map<string, Map<string, ResultState>>();
  private readonly seen = new Map<string, number>();
  private readonly undated = new Map<string, Map<string, number>>();
  private revision = 0;

  subscribe = this.changes.subscribe;
  snapshot = () => this.revision;

  private changed() {
    this.revision++;
    this.changes.notify();
  }

  observe(deviceId: string, sessions: readonly RemoteSession[], at: number) {
    const before = this.undated.get(deviceId);
    const next = new Map<string, number>();
    for (const session of sessions) {
      if (session.since !== undefined || (session.state !== "new-result" && !session.failed))
        continue;
      const key = remoteSessionKey({ deviceId, ...session });
      next.set(key, before?.get(key) ?? at);
    }
    if (next.size === (before?.size ?? 0) && [...next.keys()].every((key) => before?.has(key)))
      return;
    this.undated.set(deviceId, next);
    this.changed();
  }

  applyPage(deviceId: string, { events }: EventPage, reset = false) {
    const previous = this.history.get(deviceId);
    const history = reset || !previous ? new Map<string, ResultState>() : previous;
    this.history.set(deviceId, history);
    let changed = reset && !!previous?.size;
    for (const event of events) {
      // Terminal outcomes are already reported by the live listing.
      if (event.kind === "terminal" || event.from === event.to) continue;
      const key = remoteSessionKey({ deviceId, ...event });
      if (event.to === "closed" || event.to === "exited") {
        changed = history.delete(key) || changed;
        this.seen.delete(key);
        continue;
      }
      const outcome = event.to === "completed" || event.to === "error" ? event.to : undefined;
      const entry = history.get(key);
      if (entry?.at === event.at && entry.outcome === outcome) continue;
      history.set(key, { at: event.at, outcome });
      changed = true;
    }
    if (changed) this.changed();
  }

  /** Use the live state first. Older listings report quiet chats as idle even after a result. */
  session(deviceId: string, row: RemoteSession): RemoteSession {
    if (
      row.state === "running" ||
      row.state === "needs-you" ||
      row.state === "ended" ||
      row.limitWait
    )
      return row;
    const key = remoteSessionKey({ deviceId, ...row });
    const event = this.history.get(deviceId)?.get(key);
    const latestEvent = event && event.at >= (row.since ?? 0) ? event : undefined;
    const failed = row.failed || latestEvent?.outcome === "error";
    const at =
      row.state === "new-result" || row.failed
        ? (row.since ?? this.undated.get(deviceId)?.get(key) ?? 0)
        : latestEvent?.outcome
          ? latestEvent.at
          : undefined;
    const unread = at !== undefined && at > (this.seen.get(key) ?? -Infinity);
    const state = unread ? "new-result" : "idle";
    if (state === row.state && failed === !!row.failed && (!unread || at === row.since)) return row;
    return {
      ...row,
      state,
      ...(failed ? { failed: true } : {}),
      ...(unread ? { since: at } : {}),
    };
  }

  markSeen(rows: readonly { deviceId: string; session: RemoteSession }[]) {
    let changed = false;
    for (const { deviceId, session } of rows) {
      if (session.state !== "new-result") continue;
      const key = remoteSessionKey({ deviceId, ...session });
      const at = session.since ?? 0;
      if (at <= (this.seen.get(key) ?? -Infinity)) continue;
      this.seen.set(key, at);
      changed = true;
    }
    if (changed) this.changed();
  }
}

function watchResults(results: RemoteResults, deviceId: string, rejoin: number) {
  let live = true;
  let supported = true;
  let pending = false;
  let reading = false;
  let since = 0;
  let nextRead = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const read = async () => {
    timer = undefined;
    if (!live || !supported || reading || !pending) return;
    pending = false;
    reading = true;
    nextRead = Date.now() + READ_INTERVAL_MS;
    try {
      for (let page = 0; page < MAX_PAGES && live; page++) {
        const result = await ipcCallResult("remote", "peerSessionEvents", {
          deviceId,
          since,
          limit: PAGE_SIZE,
        });
        if (!live) return;
        if (!result.ok) {
          supported = result.kind !== "unsupported";
          return;
        }
        const { events, cursor, more } = result.value;
        const reset = since === 0 || since > cursor;
        results.applyPage(deviceId, result.value, reset);
        const next = more ? events.at(-1)?.seq : cursor;
        if (next === undefined || (next <= since && !reset)) return;
        since = next;
        if (!more) return;
      }
      pending = true;
    } finally {
      reading = false;
      schedule();
    }
  };
  const schedule = () => {
    if (!live || !supported || !pending || reading || timer !== undefined) return;
    timer = setTimeout(() => void read().catch(() => {}), Math.max(0, nextRead - Date.now()));
  };
  const stop = observePeerSessions(deviceId, rejoin, (listing) => {
    if (listing.status !== "ready") return;
    results.observe(deviceId, listing.list.sessions, Date.now());
    pending = true;
    schedule();
  });
  return () => {
    live = false;
    clearTimeout(timer);
    stop();
  };
}

/** Shares the live listings and reads the event log after a listing changes. */
export function useRemoteResults(peers: readonly RoomPeer[], shown: boolean): RemoteResults {
  const [results] = useState(() => new RemoteResults());
  useSyncExternalStore(results.subscribe, results.snapshot, results.snapshot);
  const connections = JSON.stringify(peers.map(({ id, rejoins }) => [id, rejoins ?? 0]));
  useEffect(() => {
    if (!shown) return;
    const stops = (JSON.parse(connections) as [string, number][]).map(([id, rejoin]) =>
      watchResults(results, id, rejoin),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [connections, results, shown]);
  return results;
}
