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
  readonly master: SshControlMaster | null;
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

  constructor(idleTtlMs = BROWSE_IDLE_TTL_MS) {
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
    this.sessions.set(sessionId, { sessionId, channel, master, lastUsed: Date.now() });
    return sessionId;
  }

  /**
   * Retrieves a session by id and updates its lastUsed timestamp. Returns null
   * when the session does not exist (expired or never opened).
   */
  get(sessionId: string): BrowseSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.lastUsed = Date.now();
    return session;
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
    const now = Date.now();
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
