import * as crypto from "node:crypto";
import type { AgentChannel } from "../../infra/agent/channel";
import type { SshControlMaster } from "../../infra/agent/ssh/master";

/**
 * Maximum number of directory entries returned per browseSession call.
 * Directories larger than this produce a bounded response with truncated=true.
 */
export const BROWSE_MAX_ENTRIES = 500;

/**
 * Time in milliseconds after which an idle browse session is automatically
 * disposed by the reaper timer.
 */
export const BROWSE_IDLE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * How frequently the reaper timer runs to collect expired sessions.
 */
const REAPER_INTERVAL_MS = 30_000; // 30 seconds

export interface BrowseSession {
  readonly sessionId: string;
  readonly channel: AgentChannel;
  /**
   * The ControlMaster backing this session. Becomes `null` once claimed by
   * a workspace handoff (see `claimMaster`) — after that, closing the
   * session disposes only the channel and the claimer owns the socket.
   */
  master: SshControlMaster | null;
  lastUsed: number;
}

/**
 * Holds all open browse sessions keyed by sessionId. Sessions are opened by
 * openBrowseSession (one ControlMaster per session), queried by browseSession,
 * and closed by closeBrowseSession. An idle-TTL reaper disposes sessions that
 * have not been used for BROWSE_IDLE_TTL_MS. Caller must invoke dispose() on
 * shutdown to stop the reaper and close every open session.
 */
export class SshBrowseSessionRegistry {
  private readonly sessions = new Map<string, BrowseSession>();
  private readonly reaperTimer: ReturnType<typeof setInterval>;
  private readonly nowFn: () => number;

  /**
   * @param idleTtlMs - idle TTL for the reaper (overridable in tests)
   * @param nowFn - injectable clock; defaults to Date.now (overridable in
   *   tests for deterministic lastUsed / reapExpired assertions without
   *   real time passage)
   */
  constructor(idleTtlMs = BROWSE_IDLE_TTL_MS, nowFn: () => number = Date.now) {
    this.nowFn = nowFn;
    this.reaperTimer = setInterval(() => {
      this.reapExpired(idleTtlMs);
    }, REAPER_INTERVAL_MS);
    // Do not keep the process alive just for the reaper.
    if (typeof this.reaperTimer.unref === "function") {
      this.reaperTimer.unref();
    }
  }

  /**
   * Registers a newly bootstrapped channel+master pair and returns the new sessionId.
   */
  register(channel: AgentChannel, master: SshControlMaster | null): string {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { sessionId, channel, master, lastUsed: this.nowFn() });
    return sessionId;
  }

  /**
   * Retrieves a session by id and updates its lastUsed timestamp. Returns null
   * when the session does not exist (expired or never opened).
   */
  get(sessionId: string): BrowseSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.lastUsed = this.nowFn();
    return session;
  }

  /**
   * Detaches this session's ControlMaster and returns it, transferring
   * ownership to the caller. The session keeps working over the same socket
   * for any remaining browse calls, but closing it will dispose only the
   * channel — the caller is now responsible for disposing the master.
   *
   * Used to hand a browse session's authenticated connection to a freshly
   * created workspace so the user is not prompted for credentials twice.
   * Returns null when the session is unknown or its master was already
   * claimed.
   */
  claimMaster(sessionId: string): SshControlMaster | null {
    const session = this.sessions.get(sessionId);
    if (!session?.master) return null;
    const master = session.master;
    session.master = null;
    return master;
  }

  /**
   * Closes and removes a session. Idempotent — safe to call on already-closed
   * or unknown ids.
   */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    disposeSession(session);
  }

  /**
   * Closes all open sessions and stops the reaper timer. Call on app shutdown
   * or when the renderer window is destroyed.
   */
  dispose(): void {
    clearInterval(this.reaperTimer);
    for (const session of this.sessions.values()) {
      disposeSession(session);
    }
    this.sessions.clear();
  }

  /**
   * Returns the number of currently open sessions. Used in tests.
   */
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
  } catch {
    // Dispose must not throw to the caller regardless of channel state.
  }
  try {
    session.master?.dispose();
  } catch {
    // Same — best-effort cleanup.
  }
}
