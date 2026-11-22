import { useEffect, useState, useSyncExternalStore } from "react";
import type { RemoteSession, RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { RoomPeer } from "../../../shared/remote/room";
import { createListenerBus } from "../../../shared/util/listener-bus";
import { ipcCallResult } from "../../ipc/client";
import { observePeerSessions } from "../remote/room";
import { remoteSessionKey } from "./layout";

type EventPage = RpcResult<"events.read">;
type ResultState = { at: number; outcome?: "completed" | "error" };
type PendingResult = { at: number; seen?: true };

const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const READ_INTERVAL_MS = 4000;

/** Viewing or clearing an outcome affects this account's sidebar on this device only. */
export class RemoteResults {
  private readonly changes = createListenerBus();
  private readonly history = new Map<string, Map<string, ResultState>>();
  private readonly cursors = new Map<string, number>();
  private readonly seen = new Map<string, number>();
  private readonly undated = new Map<string, Map<string, number>>();
  private readonly running = new Map<string, Set<string>>();
  private readonly pending = new Map<string, Map<string, PendingResult>>();
  private revision = 0;

  subscribe = this.changes.subscribe;
  snapshot = () => this.revision;

  private changed() {
    this.revision++;
    this.changes.notify();
  }

  cursor(deviceId: string): number {
    return this.cursors.get(deviceId) ?? 0;
  }

  observe(
    deviceId: string,
    sessions: readonly RemoteSession[],
    at: number,
    supportsEvents = true,
  ): boolean {
    const before = this.undated.get(deviceId);
    const next = new Map<string, number>();
    const wasRunning = this.running.get(deviceId);
    const running = new Set<string>();
    const previous = this.pending.get(deviceId);
    const pending = new Map<string, PendingResult>();
    let urgent = false;
    let changed = false;
    for (const session of sessions) {
      const key = remoteSessionKey({ deviceId, ...session });
      if (session.since === undefined && (session.state === "new-result" || session.failed))
        next.set(key, before?.get(key) ?? at);
      if (session.kind === "terminal") continue;
      if (session.state === "running") {
        running.add(key);
        if (!wasRunning?.has(key))
          changed = (this.history.get(deviceId)?.delete(key) ?? false) || changed;
        continue;
      }
      const finishedWorking = wasRunning?.has(key) === true;
      urgent ||= supportsEvents && finishedWorking;
      if (!supportsEvents || session.state !== "idle" || session.limitWait || session.failed)
        continue;
      if (finishedWorking) {
        pending.set(key, { at: session.since ?? at });
      } else {
        const waiting = previous?.get(key);
        if (waiting) pending.set(key, waiting);
      }
    }
    this.running.set(deviceId, running);
    this.pending.set(deviceId, pending);
    this.undated.set(deviceId, next);
    if (
      changed ||
      urgent ||
      pending.size !== (previous?.size ?? 0) ||
      next.size !== (before?.size ?? 0) ||
      [...next.keys()].some((key) => !before?.has(key))
    )
      this.changed();
    return urgent;
  }

  /** Only a read that started after a listing change can settle its provisional result. */
  settleAfterRead(deviceId: string): () => void {
    const pending = [...(this.pending.get(deviceId) ?? [])];
    return () => {
      const current = this.pending.get(deviceId);
      let changed = false;
      for (const [key, item] of pending) {
        if (current?.get(key) !== item) continue;
        const event = this.history.get(deviceId)?.get(key);
        if (item.seen && event?.outcome === "completed") this.keepSeen(key, event.at);
        current.delete(key);
        changed = true;
      }
      if (changed) this.changed();
    };
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

  /** A restarted host already returns the first page when its cursor is behind ours. */
  acceptPage(deviceId: string, page: EventPage): boolean {
    const since = this.cursor(deviceId);
    const reset = since > page.cursor;
    const next = page.more ? page.events.at(-1)?.seq : page.cursor;
    this.applyPage(deviceId, page, reset);
    this.cursors.set(deviceId, next ?? (reset ? 0 : since));
    return page.more && next !== undefined && next > (reset ? 0 : since);
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
    const latestEvent = this.history.get(deviceId)?.get(key);
    const pending = this.pending.get(deviceId)?.get(key);
    const failed = row.failed || latestEvent?.outcome === "error";
    const at =
      row.state === "new-result" || row.failed
        ? (row.since ?? this.undated.get(deviceId)?.get(key) ?? 0)
        : latestEvent?.outcome
          ? latestEvent.at
          : pending?.at;
    const unread = at !== undefined && !pending?.seen && at > (this.seen.get(key) ?? -Infinity);
    const state = unread ? "new-result" : "idle";
    if (state === row.state && failed === !!row.failed && (!unread || at === row.since)) return row;
    return {
      ...row,
      state,
      ...(failed ? { failed: true } : {}),
      ...(unread ? { since: at } : {}),
    };
  }

  private keepSeen(key: string, at: number): boolean {
    if (at <= (this.seen.get(key) ?? -Infinity)) return false;
    this.seen.set(key, at);
    return true;
  }

  markSeen(rows: readonly { deviceId: string; session: RemoteSession }[]) {
    let changed = false;
    for (const { deviceId, session } of rows) {
      if (session.state !== "new-result") continue;
      const key = remoteSessionKey({ deviceId, ...session });
      const waiting = this.pending.get(deviceId)?.get(key);
      if (waiting && !this.history.get(deviceId)?.get(key)?.outcome) {
        waiting.seen = true;
        changed = true;
      } else {
        changed = this.keepSeen(key, session.since ?? 0) || changed;
      }
    }
    if (changed) this.changed();
  }
}

export function watchResults(results: RemoteResults, deviceId: string, rejoin: number) {
  let live = true;
  let supported = true;
  let pending = false;
  let urgent = false;
  let reading = false;
  let nextRead = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const read = async () => {
    timer = undefined;
    if (!live || !supported || reading || !pending) return;
    pending = false;
    urgent = false;
    reading = true;
    nextRead = Date.now() + READ_INTERVAL_MS;
    const settle = results.settleAfterRead(deviceId);
    try {
      for (let page = 0; page < MAX_PAGES && live; page++) {
        const result = await ipcCallResult("remote", "peerSessionEvents", {
          deviceId,
          since: results.cursor(deviceId),
          limit: PAGE_SIZE,
        });
        if (!live) return;
        if (!result.ok) {
          supported = result.kind !== "unsupported";
          if (supported) pending = true;
          else results.settleAfterRead(deviceId)();
          return;
        }
        if (!results.acceptPage(deviceId, result.value)) {
          settle();
          return;
        }
      }
      pending = true;
    } catch {
      pending = true;
    } finally {
      reading = false;
      schedule();
    }
  };
  const schedule = () => {
    if (!live || !supported || !pending || reading || timer !== undefined) return;
    timer = setTimeout(() => void read(), urgent ? 0 : Math.max(0, nextRead - Date.now()));
  };
  const stop = observePeerSessions(deviceId, rejoin, (listing) => {
    if (listing.status !== "ready") return;
    if (results.observe(deviceId, listing.list.sessions, Date.now(), supported)) {
      urgent = true;
      clearTimeout(timer);
      timer = undefined;
    }
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
