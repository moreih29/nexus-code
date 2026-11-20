/**
 * The sessions' list other devices of the account watch on this one
 * (sessions.watch): while any watches, the list is made again every
 * SESSIONS_POLL_MS here, where it is cheap, and sent to each watcher as a
 * sessions.update when it is not what that watcher was sent last. The
 * watcher no longer asks over the network every few seconds, and sees a
 * change within a second. The consent prompts waiting on the user go with
 * it, as that watcher may answer them.
 */

import { randomUUID } from "node:crypto";
import {
  type RemoteSession,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
  type SessionsUpdate,
} from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/main";
import { RpcFailure } from "./room";

const log = createLogger("remote-session-watches");

/** How often the list is made again while watched. */
export const SESSIONS_POLL_MS = 1000;

/** Most lists one device may watch here at once; a new one beyond ends its oldest. */
export const MAX_SESSION_WATCHES_PER_DEVICE = 2;

type SessionsList = RpcResult<"sessions.list">;
type SessionRows = ReadonlyMap<string, readonly RemoteSession[]>;

interface Watch {
  from: string;
  /** The list as last sent, as compared (sameness). */
  sent: string;
  /** Fully read session rows in the last list, including workspaces with zero sessions. */
  rows: SessionRows;
}

/**
 * A list as compared with the one sent last: a prompt's time left goes
 * down by itself, and is no change to send.
 */
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
  /** Reads the list once, then adds the consents for each device it is sent to. */
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

  /** Starts a watch for `from`: the list now. */
  async watch(from: string): Promise<RpcResult<"sessions.watch">> {
    const mine = [...this.watches].filter(([, w]) => w.from === from);
    if (mine.length >= MAX_SESSION_WATCHES_PER_DEVICE) {
      const [oldest] = mine[0] ?? [];
      if (oldest) this.watches.delete(oldest);
    }
    const snapshot = await this.deps.snapshot(from);
    const list = await snapshot.forDevice(from);
    const watchId = randomUUID();
    this.watches.set(watchId, {
      from,
      sent: sameness(list),
      rows: rowsByWorkspace(list, snapshot.incompleteWorkspaces),
    });
    this.schedule();
    return { ...list, watchId };
  }

  /** Ends a watch `from` started; another device's is not its to end. */
  unwatch(from: string, { watchId }: RpcParams<"sessions.unwatch">): RpcResult<"sessions.unwatch"> {
    const watch = this.watches.get(watchId);
    if (!watch || watch.from !== from) throw new RpcFailure(RpcErrorCode.NotFound, "no such watch");
    this.watches.delete(watchId);
    this.schedule();
    return {};
  }

  /** A device left the room: its watches end. */
  dropDevice(deviceId: string): void {
    for (const [id, watch] of [...this.watches]) {
      if (watch.from === deviceId) this.watches.delete(id);
    }
    this.schedule();
  }

  /** This device left the room: every watch ends. */
  dropAll(): void {
    this.watches.clear();
    this.schedule();
  }

  /** The devices watching the list here now. */
  watchers(): string[] {
    return [...new Set([...this.watches.values()].map((w) => w.from))];
  }

  /** Makes the list again and sends it where it changed; also for tests. */
  async poll(): Promise<void> {
    if (this.polling || this.watches.size === 0) return;
    this.polling = true;
    try {
      const watches = [...this.watches];
      const snapshot = await this.deps.snapshot();
      const incomplete = snapshot.incompleteWorkspaces;
      const currentRows = rowsByWorkspace(snapshot.list, incomplete);
      // Each device's own list: the prompts it may answer differ.
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
        const same = sameness(update);
        if (watch.sent === same || (await this.deps.notify(watch.from, { ...update, watchId }))) {
          watch.sent = same;
          watch.rows = rows;
        }
      }
    } catch (error) {
      log.warn(`Could not list sessions: ${String(error)}`);
    } finally {
      this.polling = false;
    }
  }

  /** Polls while anything watches, and not otherwise. */
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
