/**
 * The sessions' list other devices of the account watch on this one
 * (sessions.watch): while any watches, the list is made again every
 * SESSIONS_POLL_MS here, where it is cheap, and sent to each watcher as a
 * sessions.update when it is not what that watcher was sent last. The
 * watcher no longer asks over the network every few seconds, and sees a
 * change within a second.
 */
import { randomUUID } from "node:crypto";
import {
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
  type SessionsUpdate,
} from "../../../../packages/remote-protocol/src";
import { RpcFailure } from "./room";

/** How often the list is made again while watched. */
export const SESSIONS_POLL_MS = 1000;

/** Most lists one device may watch here at once; a new one beyond ends its oldest. */
export const MAX_SESSION_WATCHES_PER_DEVICE = 2;

type SessionsList = RpcResult<"sessions.list">;

interface Watch {
  from: string;
  /** The list as last sent, as JSON. */
  sent: string;
}

export interface SessionWatchesDeps {
  /** The list now (listSessions). */
  list(): Promise<SessionsList>;
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
    const list = await this.deps.list();
    const watchId = randomUUID();
    this.watches.set(watchId, { from, sent: JSON.stringify(list) });
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
      const list = await this.deps.list();
      const json = JSON.stringify(list);
      for (const [watchId, watch] of this.watches) {
        if (watch.sent === json) continue;
        watch.sent = json;
        await this.deps.notify(watch.from, { ...list, watchId });
      }
    } catch (error) {
      console.warn("[remote] the sessions' list could not be made:", error);
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
