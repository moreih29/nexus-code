import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  MAX_MARK_SEEN,
  type RemoteSession,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src/rpc";
import type { RoomPeer } from "../../../shared/remote/room";
import type { RemoteSeenResult } from "../../../shared/types/agent-view";
import { createListenerBus } from "../../../shared/util/listener-bus";
import { ipcCallResult } from "../../ipc/client";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useAppFocusStore } from "../../state/stores/app-focus";
import {
  observePeerSessions,
  peerServes,
  refreshPeerSessions,
  useRemoteRoom,
} from "../remote/room";
import { parseRemoteSessionKey, remoteSessionKey } from "./layout";

type EventPage = RpcResult<"events.read">;
type ResultState = { at: number; outcome?: "completed" | "error"; message?: string };
type PendingResult = { at: number; seen?: true };
type SeenChanges = Map<string, RemoteSeenResult | null>;
type SeenResults = {
  get(key: string): RemoteSeenResult | undefined;
  entries(): Iterable<readonly [string, RemoteSeenResult]>;
  update(changes: SeenChanges): void;
};

function withoutListing({
  listedAt: _listedAt,
  ...seen
}: RemoteSeenResult): RemoteSeenResult | null {
  return seen.at > 0 ? seen : null;
}

function memorySeen(): SeenResults {
  const entries = new Map<string, RemoteSeenResult>();
  return {
    get: (key) => entries.get(key),
    entries: () => entries,
    update: (changes) => {
      for (const [key, value] of changes) {
        if (value === null) entries.delete(key);
        else entries.set(key, value);
      }
    },
  };
}

function savedSeen(accountKey: string): SeenResults {
  return {
    get(key) {
      const { remoteSeen } = useAgentViewStore.getState();
      return remoteSeen?.accountKey === accountKey ? remoteSeen.entries.get(key) : undefined;
    },
    entries() {
      const { remoteSeen } = useAgentViewStore.getState();
      return remoteSeen?.accountKey === accountKey ? remoteSeen.entries : [];
    },
    update(changes) {
      if (changes.size > 0) useAgentViewStore.getState().updateRemoteSeen(accountKey, changes);
    },
  };
}

export function forgetRemoteResult(target: Parameters<typeof remoteSessionKey>[0]): void {
  const { peerOrderAccount } = useAgentViewStore.getState();
  if (peerOrderAccount !== null)
    savedSeen(peerOrderAccount).update(new Map([[remoteSessionKey(target), null]]));
}

const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const READ_INTERVAL_MS = 4000;

const RECEIPTS = "sessions.markSeen";
const RECEIPT_RETRY_DELAYS = [1_000, 2_000, 4_000];
type Receipt = RpcParams<typeof RECEIPTS>["seen"][number];
type QueuedReceipt = { receipt: Receipt; retries: number };
type ResultRow = { deviceId: string; session: RemoteSession; hostReceipts?: boolean };

function hostResultTime(row: RemoteSession): number | undefined {
  const { since } = row;
  if (
    row.state === "new-result" &&
    !row.failed &&
    !row.limitWait &&
    !row.waiting &&
    since !== undefined &&
    Number.isFinite(since)
  )
    return since;
}

function receiptTime(saved: RemoteSeenResult | undefined): number | undefined {
  if (saved && !saved.undated && saved.at > 0) return saved.at;
}

interface ReceiptWatch {
  rejoin: number;
  users: number;
  stop(): void;
}

/** The sidebar and any open panes share the account's receipts to each host. */
class ReadReceipts {
  private readonly watches = new Map<string, ReceiptWatch>();
  private readonly waiting = new Map<string, Map<string, QueuedReceipt>>();
  private readonly sending = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly acknowledged = new Map<string, Map<string, number>>();

  constructor(private readonly saved: SeenResults) {}

  hides(deviceId: string, key: string, since: number): boolean {
    return (
      since <= (receiptTime(this.saved.get(key)) ?? -Infinity) ||
      since <= (this.acknowledged.get(deviceId)?.get(key) ?? -Infinity)
    );
  }

  mark(rows: readonly ResultRow[]): void {
    const changes: SeenChanges = new Map();
    const devices = new Set<string>();
    for (const { deviceId, session } of rows) {
      const upTo = hostResultTime(session);
      const key = remoteSessionKey({ deviceId, ...session });
      if (
        upTo === undefined ||
        upTo <= (changes.get(key)?.at ?? -Infinity) ||
        this.hides(deviceId, key, upTo)
      )
        continue;
      const { workspaceId, tabId } = session;
      changes.set(key, { at: upTo });
      this.enqueue(deviceId, key, { workspaceId, tabId, upTo });
      devices.add(deviceId);
    }
    this.saved.update(changes);
    for (const deviceId of devices) void this.send(deviceId);
  }

  private enqueue(deviceId: string, key: string, receipt: Receipt): void {
    let pending = this.waiting.get(deviceId);
    if (!pending) {
      pending = new Map();
      this.waiting.set(deviceId, pending);
    }
    if ((pending.get(key)?.receipt.upTo ?? -Infinity) < receipt.upTo)
      pending.set(key, { receipt, retries: 0 });
  }

  private retry(
    deviceId: string,
    pending: Map<string, QueuedReceipt>,
    batch: readonly [string, QueuedReceipt][],
  ): void {
    let nextDelay = Infinity;
    for (const [key, item] of batch) {
      const delay = RECEIPT_RETRY_DELAYS[item.retries];
      if (delay === undefined || pending.has(key)) continue;
      pending.set(key, { receipt: item.receipt, retries: item.retries + 1 });
      nextDelay = Math.min(nextDelay, delay);
    }
    if (!Number.isFinite(nextDelay)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(deviceId);
      void this.send(deviceId);
    }, nextDelay);
    this.retryTimers.set(deviceId, timer);
  }

  private stopWatch(deviceId: string, watch: ReceiptWatch): void {
    this.watches.delete(deviceId);
    watch.stop();
    const timer = this.retryTimers.get(deviceId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(deviceId);
      this.waiting.delete(deviceId);
    }
  }

  private async send(deviceId: string): Promise<void> {
    const pending = this.waiting.get(deviceId);
    if (!pending?.size || this.sending.has(deviceId) || this.retryTimers.has(deviceId)) return;
    const watch = this.watches.get(deviceId);
    const batch = [...pending].slice(0, MAX_MARK_SEEN);
    for (const [key] of batch) pending.delete(key);
    this.sending.add(deviceId);
    let delivered = false;
    try {
      const result = await ipcCallResult("remote", "peerSessionsMarkSeen", {
        deviceId,
        seen: batch.map(([, { receipt }]) => receipt),
      });
      if (!result.ok) return;
      delivered = true;
      const acknowledged = this.acknowledged.get(deviceId) ?? new Map<string, number>();
      this.acknowledged.set(deviceId, acknowledged);
      const changes: SeenChanges = new Map();
      for (const [
        key,
        {
          receipt: { upTo },
        },
      ] of batch) {
        acknowledged.set(key, upTo);
        if (receiptTime(this.saved.get(key)) === upTo) changes.set(key, null);
        if (pending.get(key)?.receipt.upTo === upTo) pending.delete(key);
      }
      this.saved.update(changes);
      refreshPeerSessions(deviceId);
    } catch {
      // A rejected IPC call is retried on the same terms as a failed response.
    } finally {
      this.sending.delete(deviceId);
      if (!delivered && watch && this.watches.get(deviceId) === watch)
        this.retry(deviceId, pending, batch);
      if (pending.size > 0) void this.send(deviceId);
      else this.waiting.delete(deviceId);
    }
  }

  private reconcile(
    deviceId: string,
    sessions: readonly RemoteSession[],
    incomplete: ReadonlySet<string>,
    previouslyIncomplete?: ReadonlySet<string>,
  ): void {
    const listing = new Map(sessions.map((row) => [remoteSessionKey({ deviceId, ...row }), row]));
    const changes: SeenChanges = new Map();
    for (const [key, saved] of this.saved.entries()) {
      const target = parseRemoteSessionKey(key);
      if (
        target?.deviceId !== deviceId ||
        incomplete.has(target.workspaceId) ||
        (previouslyIncomplete && !previouslyIncomplete.has(target.workspaceId))
      )
        continue;
      const row = listing.get(key);
      const upTo = row && hostResultTime(row);
      if (row && upTo !== undefined && upTo <= (receiptTime(saved) ?? -Infinity)) {
        const { workspaceId, tabId } = row;
        changes.set(key, { at: upTo });
        this.enqueue(deviceId, key, { workspaceId, tabId, upTo });
      } else {
        changes.set(key, null);
      }
    }
    this.saved.update(changes);
    void this.send(deviceId);
  }

  watch(deviceId: string, rejoin: number): () => void {
    const current = this.watches.get(deviceId);
    let watch = current;
    if (!watch || watch.rejoin !== rejoin) {
      if (current) this.stopWatch(deviceId, current);
      let remaining: ReadonlySet<string> | undefined;
      // A shared listing can deliver its cached snapshot during subscribe.
      watch = { rejoin, users: 0, stop: () => {} };
      this.watches.set(deviceId, watch);
      watch.stop = observePeerSessions(deviceId, rejoin, (listing) => {
        if (listing.status !== "ready") return;
        this.acknowledged.delete(deviceId);
        if (remaining?.size === 0) return;
        const incomplete = new Set(listing.list.incompleteWorkspaces);
        this.reconcile(deviceId, listing.list.sessions, incomplete, remaining);
        remaining = remaining
          ? new Set([...remaining].filter((id) => incomplete.has(id)))
          : incomplete;
      });
    }
    watch.users++;
    return () => {
      watch.users--;
      if (watch.users > 0 || this.watches.get(deviceId) !== watch) return;
      this.stopWatch(deviceId, watch);
    };
  }
}

let accountReceipts: { key: string; receipts: ReadReceipts } | undefined;

function receiptsFor(accountKey: string): ReadReceipts {
  if (accountReceipts?.key !== accountKey)
    accountReceipts = { key: accountKey, receipts: new ReadReceipts(savedSeen(accountKey)) };
  return accountReceipts.receipts;
}

/** Both receipt-aware hosts and older hosts feed the remote sidebar's result rows. */
export class RemoteResults {
  private readonly changes = createListenerBus();
  private readonly history = new Map<string, Map<string, ResultState>>();
  private readonly cursors = new Map<string, number>();
  private readonly undated = new Map<string, Map<string, number>>();
  private readonly terminals = new Map<string, Set<string>>();
  private readonly running = new Map<string, Set<string>>();
  private readonly pending = new Map<string, Map<string, PendingResult>>();
  private readonly seen: SeenResults;
  private readonly receipts: ReadReceipts;
  private revision = 0;

  subscribe = this.changes.subscribe;
  snapshot = () => this.revision;

  constructor(accountKey: string | null = null) {
    this.seen = accountKey === null ? memorySeen() : savedSeen(accountKey);
    this.receipts = accountKey === null ? new ReadReceipts(this.seen) : receiptsFor(accountKey);
  }

  watchReceipts(deviceId: string, rejoin: number): () => void {
    return this.receipts.watch(deviceId, rejoin);
  }

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
    const terminals = new Set<string>();
    const seenChanges: SeenChanges = new Map();
    const previous = this.pending.get(deviceId);
    const pending = new Map<string, PendingResult>();
    let urgent = false;
    let changed = false;
    for (const session of sessions) {
      const key = remoteSessionKey({ deviceId, ...session });
      const seen = this.seen.get(key);
      if (session.kind === "terminal" && session.state !== "ended") terminals.add(key);
      if (seen && (session.state === "ended" || (seen.undated && session.state !== "new-result")))
        seenChanges.set(key, null);
      if (seen?.listedAt !== undefined && session.state === "running")
        seenChanges.set(key, withoutListing(seen));
      if (session.since === undefined && session.state === "new-result")
        next.set(key, before?.get(key) ?? at);
      if (session.state === "running") {
        running.add(key);
        const history = this.history.get(deviceId);
        const outcome = history?.get(key);
        // A read can finish before a listing that still reports this turn as running.
        if (
          !wasRunning?.has(key) &&
          outcome &&
          (session.since === undefined || outcome.at <= session.since)
        )
          changed = (history?.delete(key) ?? false) || changed;
        continue;
      }
      if (session.kind === "terminal") continue;
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
    for (const key of this.terminals.get(deviceId) ?? []) {
      if (!terminals.has(key) && this.seen.get(key)) seenChanges.set(key, null);
    }
    this.terminals.set(deviceId, terminals);
    this.running.set(deviceId, running);
    this.pending.set(deviceId, pending);
    this.undated.set(deviceId, next);
    this.seen.update(seenChanges);
    if (
      changed ||
      seenChanges.size > 0 ||
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
      const seenChanges: SeenChanges = new Map();
      for (const [key, item] of pending) {
        if (current?.get(key) !== item) continue;
        const event = this.history.get(deviceId)?.get(key);
        if (item.seen && event?.outcome === "completed")
          this.keepSeen(seenChanges, key, { at: event.at });
        current.delete(key);
        changed = true;
      }
      this.seen.update(seenChanges);
      if (changed) this.changed();
    };
  }

  applyPage(deviceId: string, { events }: EventPage, reset = false) {
    const previous = this.history.get(deviceId);
    const history = reset || !previous ? new Map<string, ResultState>() : previous;
    this.history.set(deviceId, history);
    let changed = reset && !!previous?.size;
    const seenChanges: SeenChanges = new Map();
    for (const event of events) {
      if (event.from === event.to) continue;
      const key = remoteSessionKey({ deviceId, ...event });
      if (event.to === "closed" || event.to === "exited") {
        changed = history.delete(key) || changed;
        if (this.seen.get(key)) seenChanges.set(key, null);
        continue;
      }
      // Terminal success already comes from the live listing. Keep legacy errors until a new turn.
      const outcome =
        event.to === "error" || (event.kind !== "terminal" && event.to === "completed")
          ? event.to
          : undefined;
      const entry = history.get(key);
      if ((event.to === "idle" || event.to === "quiet") && entry?.outcome === "error") continue;
      const message = outcome === "error" ? event.message : undefined;
      if (entry?.at === event.at && entry.outcome === outcome && entry.message === message)
        continue;
      history.set(key, { at: event.at, outcome, message });
      changed = true;
    }
    this.seen.update(seenChanges);
    if (changed || seenChanges.size > 0) this.changed();
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
  session(
    deviceId: string,
    row: RemoteSession,
    reportsFailure = false,
    hostReceipts = false,
  ): RemoteSession {
    if (hostReceipts) {
      const since = hostResultTime(row);
      if (
        row.state !== "new-result" ||
        (since !== undefined &&
          !this.receipts.hides(deviceId, remoteSessionKey({ deviceId, ...row }), since))
      )
        return row;
      return { ...row, state: "idle" };
    }
    if (
      row.state === "running" ||
      row.state === "needs-you" ||
      row.state === "ended" ||
      row.limitWait ||
      row.failed
    )
      return row;
    const key = remoteSessionKey({ deviceId, ...row });
    const latestEvent = this.history.get(deviceId)?.get(key);
    const pending = this.pending.get(deviceId)?.get(key);
    if (!reportsFailure && row.state === "idle" && latestEvent?.outcome === "error") {
      return { ...row, failed: true, since: latestEvent.at, last: latestEvent.message ?? row.last };
    }
    const at =
      row.state === "new-result"
        ? (row.since ?? this.undated.get(deviceId)?.get(key) ?? 0)
        : latestEvent?.outcome === "completed"
          ? latestEvent.at
          : pending?.at;
    const seen = this.seen.get(key);
    const read =
      row.state === "new-result" && row.since === undefined
        ? seen?.undated
        : (seen?.listedAt !== undefined && seen.listedAt === (row.since ?? null)) ||
          (at !== undefined && at <= (seen?.at ?? -Infinity));
    const unread = at !== undefined && !pending?.seen && !read;
    const state = unread ? "new-result" : "idle";
    if (state === row.state && (!unread || at === row.since)) return row;
    return {
      ...row,
      state,
      ...(unread ? { since: at } : {}),
    };
  }

  private keepSeen(changes: SeenChanges, key: string, value: RemoteSeenResult): void {
    const before = changes.get(key) ?? this.seen.get(key);
    if (value.undated ? before?.undated : value.at <= (before?.at ?? -Infinity)) return;
    changes.set(key, value);
  }

  markSeen(rows: readonly ResultRow[]) {
    this.receipts.mark(rows.filter((row) => row.hostReceipts));
    let pendingChanged = false;
    const changes: SeenChanges = new Map();
    for (const { deviceId, session, hostReceipts } of rows) {
      if (
        hostReceipts ||
        session.state !== "new-result" ||
        session.failed ||
        session.limitWait ||
        session.waiting
      )
        continue;
      const key = remoteSessionKey({ deviceId, ...session });
      const waiting = this.pending.get(deviceId)?.get(key);
      if (waiting && !this.history.get(deviceId)?.get(key)?.outcome) {
        if (!waiting.seen) {
          waiting.seen = true;
          pendingChanged = true;
        }
      } else {
        const undated = session.since === undefined || this.undated.get(deviceId)?.has(key);
        this.keepSeen(changes, key, {
          at: undated ? 0 : (session.since ?? 0),
          ...(undated ? { undated: true } : {}),
        });
      }
    }
    this.seen.update(changes);
    if (pendingChanged || changes.size > 0) this.changed();
  }
}

export function markVisibleRemoteResult(
  accountKey: string,
  deviceId: string,
  session: RemoteSession | undefined,
  visible: boolean,
  focused: boolean,
  hostReceipts = false,
) {
  if (!visible || !session) return;
  if (hostReceipts) {
    if (focused) receiptsFor(accountKey).mark([{ deviceId, session }]);
    return;
  }
  const key = remoteSessionKey({ deviceId, ...session });
  const seen = savedSeen(accountKey);
  const before = seen.get(key);
  if (session.state === "ended" || (before?.undated && session.state !== "new-result")) {
    if (before) seen.update(new Map([[key, null]]));
    return;
  }
  if (session.state === "running" && before?.listedAt !== undefined) {
    seen.update(new Map([[key, withoutListing(before)]]));
    return;
  }
  if (!focused || session.failed || session.limitWait || session.waiting) return;
  if (session.state === "new-result") {
    const value: RemoteSeenResult = {
      at: session.since ?? 0,
      ...(session.since === undefined ? { undated: true } : {}),
    };
    if (value.undated ? !before?.undated : value.at > (before?.at ?? -Infinity))
      seen.update(new Map([[key, value]]));
  } else if (session.kind !== "terminal" && session.state === "idle") {
    // Listings and the event log can timestamp the same result differently.
    // Match the viewed listing on peers that report its time.
    const value = { at: before?.at ?? 0, listedAt: session.since ?? null };
    seen.update(new Map([[key, value]]));
  }
}

/** An open pane already watches its listing, even while the sidebar is hidden. */
export function useRemotePaneSeen(
  deviceId: string,
  session: RemoteSession | undefined,
  visible: boolean,
) {
  const accountKey = useAgentViewStore((s) => s.peerOrderAccount);
  const focused = useAppFocusStore((s) => s.focused);
  const room = useRemoteRoom();
  const peer = room?.peers.find((p) => p.id === deviceId);
  const hostReceipts = peerServes(peer, RECEIPTS);
  const online = room?.status === "online" && peer?.online === true;
  const rejoin = peer?.rejoins ?? 0;
  useEffect(() => {
    if (accountKey !== null && hostReceipts && online && visible)
      return receiptsFor(accountKey).watch(deviceId, rejoin);
  }, [accountKey, deviceId, hostReceipts, online, rejoin, visible]);
  useEffect(() => {
    if (accountKey !== null)
      markVisibleRemoteResult(accountKey, deviceId, session, visible, focused, hostReceipts);
  }, [accountKey, deviceId, focused, hostReceipts, session, visible]);
}

export function watchResults(
  results: RemoteResults,
  deviceId: string,
  rejoin: number,
  hostReceipts = false,
) {
  if (hostReceipts) return results.watchReceipts(deviceId, rejoin);
  let live = true;
  let supported = true;
  let pending = true;
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
  schedule();
  return () => {
    live = false;
    clearTimeout(timer);
    stop();
  };
}

/** Shares the live listings and reads the event log after a listing changes. */
export function useRemoteResults(
  peers: readonly RoomPeer[],
  shown: boolean,
  accountKey: string | null,
): RemoteResults {
  const results = useMemo(() => new RemoteResults(accountKey), [accountKey]);
  useAgentViewStore((state) => state.remoteSeen);
  useSyncExternalStore(results.subscribe, results.snapshot, results.snapshot);
  const connections = JSON.stringify(
    peers.map((peer) => [peer.id, peer.rejoins ?? 0, peerServes(peer, RECEIPTS)]),
  );
  useEffect(() => {
    if (!shown) return;
    const stops = (JSON.parse(connections) as [string, number, boolean][]).map(
      ([id, rejoin, receipts]) => watchResults(results, id, rejoin, receipts),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [connections, results, shown]);
  return results;
}
