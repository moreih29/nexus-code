import * as crypto from "node:crypto";
import type { AgentChannel } from "../../infra/agent/channel";
import type { SshControlMaster } from "../../infra/agent/ssh/master";

export const BROWSE_MAX_ENTRIES = 500;

export const BROWSE_IDLE_TTL_MS = 2 * 60 * 1000;

const REAPER_INTERVAL_MS = 30_000;

export interface BrowseSession {
  readonly sessionId: string;
  readonly channel: AgentChannel;
  master: SshControlMaster | null;
  lastUsed: number;
}

export class SshBrowseSessionRegistry {
  private readonly sessions = new Map<string, BrowseSession>();
  private readonly reaperTimer: ReturnType<typeof setInterval>;
  private readonly nowFn: () => number;

  constructor(idleTtlMs = BROWSE_IDLE_TTL_MS, nowFn: () => number = Date.now) {
    this.nowFn = nowFn;
    this.reaperTimer = setInterval(() => {
      this.reapExpired(idleTtlMs);
    }, REAPER_INTERVAL_MS);
    if (typeof this.reaperTimer.unref === "function") {
      this.reaperTimer.unref();
    }
  }

  register(channel: AgentChannel, master: SshControlMaster | null): string {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { sessionId, channel, master, lastUsed: this.nowFn() });
    return sessionId;
  }

  get(sessionId: string): BrowseSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.lastUsed = this.nowFn();
    return session;
  }

  claimMaster(sessionId: string): SshControlMaster | null {
    const session = this.sessions.get(sessionId);
    if (!session?.master) return null;
    const master = session.master;
    session.master = null;
    return master;
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    disposeSession(session);
  }

  closeAll(): void {
    for (const sessionId of this.sessions.keys()) this.close(sessionId);
  }

  dispose(): void {
    clearInterval(this.reaperTimer);
    this.closeAll();
  }

  size(): number {
    return this.sessions.size;
  }

  private reapExpired(idleTtlMs: number): void {
    const now = this.nowFn();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastUsed >= idleTtlMs) {
        this.sessions.delete(sessionId);
        disposeSession(session);
      }
    }
  }
}

function disposeSession(session: BrowseSession): void {
  try {
    session.channel.dispose();
  } catch {}
  try {
    session.master?.dispose();
  } catch {}
}
