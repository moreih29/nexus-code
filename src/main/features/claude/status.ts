import type { ClaudeStatus, StatusEntry } from "../../../shared/claude/status";
import { broadcast } from "../../infra/ipc-router";

interface StateEntry {
  status: ClaudeStatus;
  message?: string;
  since: number;
  prompt?: string;
  turnStartedAt?: number;
  answer?: string;
  notice?: string;
}

const WAITING: ReadonlySet<ClaudeStatus> = new Set(["needsInput", "permissionPending", "error"]);

export type ClaudeStatusListener = (
  workspaceId: string,
  tabId: string,
  entry: { status: ClaudeStatus; since: number } | null,
) => void;

export class ClaudeStatusBroker {
  private readonly map = new Map<string, StateEntry>();

  private readonly broadcastFn: (channel: string, event: string, args: unknown) => void;

  private readonly listeners = new Set<ClaudeStatusListener>();

  constructor(broadcastFn: (channel: string, event: string, args: unknown) => void = broadcast) {
    this.broadcastFn = broadcastFn;
  }

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

  get(workspaceId: string, tabId: string): StateEntry | null {
    return this.map.get(`${workspaceId}:${tabId}`) ?? null;
  }

  clear(workspaceId: string, tabId: string): void {
    const key = `${workspaceId}:${tabId}`;
    if (!this.map.has(key)) return;
    this.map.delete(key);
    for (const listener of this.listeners) listener(workspaceId, tabId, null);
    this.broadcastFn("claude", "cleared", { workspaceId, tabId });
  }

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

  onChange(listener: ClaudeStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

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
