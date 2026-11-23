import { randomUUID } from "node:crypto";
import {
  type RemoteSession,
  RpcErrorCode,
  type RpcParams,
  type RpcRequest,
  type RpcResult,
  type SessionsUpdate,
} from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/main";
import { RpcFailure } from "./room";
import { fitSessionReply, fitSessionUpdate, type OpenerDetail } from "./session-list-size";

const log = createLogger("remote-session-watches");

export const SESSIONS_POLL_MS = 1000;

export const MAX_SESSION_WATCHES_PER_DEVICE = 2;

type SessionsList = RpcResult<"sessions.list">;
type SessionRows = ReadonlyMap<string, readonly RemoteSession[]>;

interface Watch {
  from: string;
  sent: string;
  detail: OpenerDetail;
  rows: SessionRows;
}

function sameness(list: SessionsList): string {
  return JSON.stringify(list, (key, value) => (key === "expiresInMs" ? undefined : value));
}

function rowsByWorkspace(list: SessionsList, incomplete: ReadonlySet<string>): SessionRows {
  const rows = new Map<string, RemoteSession[]>();
  for (const { id } of list.workspaces) {
    if (!incomplete.has(id)) rows.set(id, []);
  }
  for (const session of list.sessions) rows.get(session.workspaceId)?.push(session);
  return rows;
}

function withPreviousRows(
  current: SessionRows,
  incomplete: ReadonlySet<string>,
  previous: SessionRows,
): SessionRows | undefined {
  if (incomplete.size === 0) return current;
  const rows = new Map(current);
  for (const id of incomplete) {
    const retained = previous.get(id);
    if (!retained) return undefined;
    rows.set(id, retained);
  }
  return rows;
}

export interface SessionWatchesDeps {
  snapshot(from?: string): Promise<{
    list: SessionsList;
    incompleteWorkspaces: ReadonlySet<string>;
    forDevice(to: string): Promise<SessionsList>;
  }>;
  notify(to: string, update: SessionsUpdate): Promise<boolean>;
  readonly pollMs?: number;
}

export class SessionWatches {
  private readonly watches = new Map<string, Watch>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly deps: SessionWatchesDeps) {}

  async watch(from: string, id: RpcRequest["id"] = 0): Promise<RpcResult<"sessions.watch">> {
    const snapshot = await this.deps.snapshot(from);
    const list = await snapshot.forDevice(from);
    const watchId = randomUUID();
    const first = { ...list, watchId };
    const fitted = fitSessionReply(first, id);
    if (!fitted) return first;

    const mine = [...this.watches].filter(([, w]) => w.from === from);
    if (mine.length >= MAX_SESSION_WATCHES_PER_DEVICE) {
      const [oldest] = mine[0] ?? [];
      if (oldest) this.watches.delete(oldest);
    }
    this.watches.set(watchId, {
      from,
      sent: sameness(fitted.list),
      detail: fitted.detail,
      rows: rowsByWorkspace(list, snapshot.incompleteWorkspaces),
    });
    this.schedule();
    return fitted.list;
  }

  unwatch(from: string, { watchId }: RpcParams<"sessions.unwatch">): RpcResult<"sessions.unwatch"> {
    const watch = this.watches.get(watchId);
    if (!watch || watch.from !== from) throw new RpcFailure(RpcErrorCode.NotFound, "no such watch");
    this.watches.delete(watchId);
    this.schedule();
    return {};
  }

  dropDevice(deviceId: string): void {
    for (const [id, watch] of [...this.watches]) {
      if (watch.from === deviceId) this.watches.delete(id);
    }
    this.schedule();
  }

  dropAll(): void {
    this.watches.clear();
    this.schedule();
  }

  watchers(): string[] {
    return [...new Set([...this.watches.values()].map((w) => w.from))];
  }

  async poll(): Promise<void> {
    if (this.polling || this.watches.size === 0) return;
    this.polling = true;
    try {
      const watches = [...this.watches];
      const snapshot = await this.deps.snapshot();
      const incomplete = snapshot.incompleteWorkspaces;
      const currentRows = rowsByWorkspace(snapshot.list, incomplete);
      const lists = new Map<string, SessionsList>();
      for (const [watchId, watch] of watches) {
        const rows = withPreviousRows(currentRows, incomplete, watch.rows);
        if (!rows) continue;
        let list = lists.get(watch.from);
        if (!list) {
          list = await snapshot.forDevice(watch.from);
          lists.set(watch.from, list);
        }
        if (this.watches.get(watchId) !== watch) continue;
        const update =
          incomplete.size === 0
            ? list
            : { ...list, sessions: list.workspaces.flatMap(({ id }) => rows.get(id) ?? []) };
        const fitted = fitSessionUpdate({ ...update, watchId }, watch.detail);
        if (!fitted) continue;
        const same = sameness(fitted.list);
        if (watch.sent === same || (await this.deps.notify(watch.from, fitted.list))) {
          watch.sent = same;
          watch.detail = fitted.detail;
          watch.rows = rows;
        }
      }
    } catch (error) {
      log.warn(`Could not list sessions: ${String(error)}`);
    } finally {
      this.polling = false;
    }
  }

  private schedule(): void {
    if (this.watches.size > 0 && !this.timer) {
      this.timer = setInterval(() => void this.poll(), this.deps.pollMs ?? SESSIONS_POLL_MS);
      this.timer.unref?.();
    } else if (this.watches.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
