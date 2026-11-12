// Claude session status broker — keeps the status of each (workspaceId, tabId) pair in memory and
// broadcasts changes to the renderer.

import type { ClaudeStatus, StatusEntry } from "../../../shared/claude/status";
import { broadcast } from "../../infra/ipc-router";

/** Internal storage unit */
interface StateEntry {
  status: ClaudeStatus;
  /** What the session shows: the notice while it waits on the user, else the answer. */
  message?: string;
  /** When the status last changed; a new message or prompt alone keeps it. */
  since: number;
  prompt?: string;
  /** When Claude last started working: a prompt came in, or it went to running. */
  turnStartedAt?: number;
  /** Claude's answer at the end of its last turn, kept until the next turn ends. */
  answer?: string;
  /** What a state waiting on the user says, as a question or a permission; gone with that state. */
  notice?: string;
}

/** States the session waits on the user in; their message is about that wait. */
const WAITING: ReadonlySet<ClaudeStatus> = new Set(["needsInput", "permissionPending", "error"]);

/** Status change listener — the entry is null on clear. */
export type ClaudeStatusListener = (
  workspaceId: string,
  tabId: string,
  entry: { status: ClaudeStatus; since: number } | null,
) => void;

/**
 * Broker that manages the Claude session status of each (workspaceId, tabId) pair.
 *
 * - set: updates the status. Skips the broadcast when the value equals the previous one.
 * - get: returns the current status, or null if none.
 * - clear: removes that (ws, tab) entry from the map.
 * - snapshot: returns all current entries as a StatusEntry array.
 */
export class ClaudeStatusBroker {
  /** Internal status map — "workspaceId:tabId" → StateEntry */
  private readonly map = new Map<string, StateEntry>();

  /** Used to inject a broadcast function in tests. */
  private readonly broadcastFn: (channel: string, event: string, args: unknown) => void;

  private readonly listeners = new Set<ClaudeStatusListener>();

  constructor(broadcastFn: (channel: string, event: string, args: unknown) => void = broadcast) {
    this.broadcastFn = broadcastFn;
  }

  /**
   * Sets the status of a given (workspaceId, tabId).
   * Does not broadcast when the status equals the previous one.
   *
   * message: for a state that waits on the user (needsInput,
   * permissionPending, error), what it says; it goes with that state. For any
   * other state, Claude's answer to the turn that ended ("" when it gave
   * none), which stays once the turn is seen. Undefined keeps the answer.
   *
   * prompt: undefined keeps the previous prompt, null clears it (new session).
   * The answer goes with the prompt it answers: a new prompt or a new
   * session has none yet. A turn Claude Code starts itself keeps both.
   */
  set(
    workspaceId: string,
    tabId: string,
    status: ClaudeStatus,
    message?: string,
    prompt?: string | null,
  ): void {
    const key = `${workspaceId}:${tabId}`;
    const prev = this.map.get(key);
    const nextPrompt = prompt === null ? undefined : (prompt ?? prev?.prompt);
    const waiting = WAITING.has(status);
    const kept = prompt === undefined ? prev?.answer : undefined;
    const answer = waiting || message === undefined ? kept : message || undefined;
    const notice = waiting ? message : undefined;
    const shown = notice ?? answer;

    // Skip the broadcast when status, message and prompt are all unchanged.
    if (
      prev &&
      prev.status === status &&
      prev.message === shown &&
      prev.prompt === nextPrompt &&
      prev.answer === answer
    ) {
      return;
    }

    const now = Date.now();
    const since = prev && prev.status === status ? prev.since : now;
    const startsTurn =
      status === "running" && (prev?.status !== "running" || typeof prompt === "string");
    const turnStartedAt = startsTurn ? now : prev?.turnStartedAt;
    this.map.set(key, {
      status,
      message: shown,
      since,
      prompt: nextPrompt,
      answer,
      notice,
      ...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
    });
    for (const listener of this.listeners) listener(workspaceId, tabId, { status, since });

    const entry: StatusEntry = {
      workspaceId,
      tabId,
      status,
      since,
      ...(shown !== undefined ? { message: shown } : {}),
      ...(nextPrompt !== undefined ? { prompt: nextPrompt } : {}),
    };
    this.broadcastFn("claude", "status", entry);
  }

  /**
   * Returns the current status of a given (workspaceId, tabId), or null if none.
   */
  get(workspaceId: string, tabId: string): StateEntry | null {
    return this.map.get(`${workspaceId}:${tabId}`) ?? null;
  }

  /**
   * Removes a given (workspaceId, tabId) entry from the map and broadcasts a cleared event to the
   * renderer.
   *
   * Called when a PTY session ends or on the `session-end` hook. Without the broadcast, the renderer's
   * useClaudeStatusStore keeps the last status, so the sidebar workspace indicator and the tab
   * indicator show a stale running state.
   *
   * Clearing a nonexistent entry skips the broadcast (the same noise-suppression policy as the
   * dedupe in set).
   */
  clear(workspaceId: string, tabId: string): void {
    const key = `${workspaceId}:${tabId}`;
    if (!this.map.has(key)) return;
    this.map.delete(key);
    for (const listener of this.listeners) listener(workspaceId, tabId, null);
    this.broadcastFn("claude", "cleared", { workspaceId, tabId });
  }

  /**
   * Removes every (workspaceId, tabId) entry that belongs to a given workspaceId from the map and
   * broadcasts a cleared event for each tab.
   *
   * Called when the user picks "reset notifications" in the sidebar context menu.
   * The Claude wrapper hook cannot control every situation, so an indicator can get stuck in a stale
   * state (e.g. still running after it finished); this is the path for the user to recover manually.
   *
   * The entries must be removed from the broker (the authoritative state), or the next snapshot or
   * re-broadcast would revive the stale state. With nothing to remove, the broadcast is skipped.
   */
  clearWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}:`;
    for (const key of this.map.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.map.delete(key);
      const tabId = key.slice(prefix.length);
      for (const listener of this.listeners) listener(workspaceId, tabId, null);
      this.broadcastFn("claude", "cleared", { workspaceId, tabId });
    }
  }

  /**
   * Calls the listener whenever a status changes or is cleared (for recording session history).
   * Unsubscribe with the returned function.
   */
  onChange(listener: ClaudeStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns all current (workspaceId, tabId) statuses as a StatusEntry array.
   * Used for the one-time snapshot sync when the renderer initializes.
   */
  snapshot(): StatusEntry[] {
    const result: StatusEntry[] = [];
    for (const [key, entry] of this.map) {
      const colonIdx = key.indexOf(":");
      const workspaceId = key.slice(0, colonIdx);
      const tabId = key.slice(colonIdx + 1);
      result.push({
        workspaceId,
        tabId,
        status: entry.status,
        since: entry.since,
        ...(entry.message !== undefined ? { message: entry.message } : {}),
        ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
      });
    }
    return result;
  }
}
