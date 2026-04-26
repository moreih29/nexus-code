import type { WorkspaceId } from "../../../contracts/workspace";
import type { AdapterMetadata, HarnessAdapter, ObserverEvent, TabBadgeEvent } from "../../HarnessAdapter";
import {
  CLAUDE_CODE_ADAPTER_NAME,
  CLAUDE_CODE_ADAPTER_VERSION,
  mapNormalizedClaudeCodeHookEventToTabBadgeEvent,
  normalizeClaudeCodeHookEvent,
} from "./state-mapper";

export type ClaudeCodeAdapterInputEvent = unknown;
export type ClaudeCodeObserverEventStream = AsyncIterable<ClaudeCodeAdapterInputEvent>;
export type ClaudeCodeObserverEventStreamFactory = (
  workspaceId: WorkspaceId,
  signal: AbortSignal,
) => ClaudeCodeObserverEventStream;

export interface ClaudeCodeAdapterOptions {
  readonly eventStream: ClaudeCodeObserverEventStream | ClaudeCodeObserverEventStreamFactory;
  readonly adapterName?: string;
  readonly version?: string;
  readonly now?: () => Date;
}

export interface ClaudeCodeLatestSession {
  readonly sessionId: string;
  readonly adapterName: string;
  readonly workspaceId: WorkspaceId;
  readonly timestamp: string;
  readonly sequence: number;
}

interface InternalLatestSession extends ClaudeCodeLatestSession {
  readonly epochMs: number;
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  private readonly eventStream: ClaudeCodeAdapterOptions["eventStream"];
  private readonly adapterName: string;
  private readonly version: string;
  private readonly now: () => Date;
  private readonly abortController = new AbortController();
  private disposed = false;
  private sequence = 0;
  private readonly latestSessionByWorkspace = new Map<WorkspaceId, InternalLatestSession>();

  constructor(options: ClaudeCodeAdapterOptions) {
    this.eventStream = options.eventStream;
    this.adapterName = options.adapterName ?? CLAUDE_CODE_ADAPTER_NAME;
    this.version = options.version ?? CLAUDE_CODE_ADAPTER_VERSION;
    this.now = options.now ?? (() => new Date());
  }

  describe(): AdapterMetadata {
    return {
      name: this.adapterName,
      version: this.version,
      observationPath: "hooks-api",
    };
  }

  observe(workspaceId: WorkspaceId): AsyncIterable<ObserverEvent> {
    return this.observeTabBadgeEvents(workspaceId);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abortController.abort();
  }

  getLatestSession(workspaceId?: WorkspaceId): ClaudeCodeLatestSession | undefined {
    const latestSession = workspaceId
      ? this.latestSessionByWorkspace.get(workspaceId)
      : [...this.latestSessionByWorkspace.values()].sort((left, right) => {
          if (left.epochMs !== right.epochMs) {
            return right.epochMs - left.epochMs;
          }
          return right.sequence - left.sequence;
        })[0];

    if (!latestSession) {
      return undefined;
    }
    const { epochMs: _epochMs, ...latest } = latestSession;
    return latest;
  }

  private async *observeTabBadgeEvents(workspaceId: WorkspaceId): AsyncIterable<ObserverEvent> {
    if (this.disposed) {
      return;
    }

    for await (const input of this.resolveEventStream(workspaceId)) {
      if (this.disposed) {
        return;
      }

      const tabBadgeEvent = this.normalizeInputEvent(input, workspaceId);
      if (tabBadgeEvent) {
        yield tabBadgeEvent;
      }
    }
  }

  private resolveEventStream(workspaceId: WorkspaceId): ClaudeCodeObserverEventStream {
    if (typeof this.eventStream === "function") {
      return this.eventStream(workspaceId, this.abortController.signal);
    }
    return this.eventStream;
  }

  private normalizeInputEvent(input: unknown, workspaceId: WorkspaceId): TabBadgeEvent | undefined {
    const observerEvent = tabBadgeEventFromObserverEvent(input);
    if (observerEvent) {
      if (observerEvent.workspaceId !== workspaceId || observerEvent.adapterName !== this.adapterName) {
        return undefined;
      }
      return this.acceptLatestSession(observerEvent) ? observerEvent : undefined;
    }

    const hookEvent = normalizeClaudeCodeHookEvent(input, {
      workspaceId,
      adapterName: this.adapterName,
      now: this.now,
    });
    if (!hookEvent || hookEvent.adapterName !== this.adapterName) {
      return undefined;
    }

    const latestAccepted = this.acceptLatestSession({
      sessionId: hookEvent.sessionId,
      adapterName: hookEvent.adapterName,
      workspaceId: hookEvent.workspaceId,
      timestamp: hookEvent.timestamp,
    });
    if (!latestAccepted) {
      return undefined;
    }

    return mapNormalizedClaudeCodeHookEventToTabBadgeEvent(hookEvent);
  }

  private acceptLatestSession(event: Pick<TabBadgeEvent, "sessionId" | "adapterName" | "workspaceId" | "timestamp">): boolean {
    const epochMs = timestampEpochMs(event.timestamp, this.now);
    const sequence = ++this.sequence;
    const candidate: InternalLatestSession = {
      sessionId: event.sessionId,
      adapterName: event.adapterName,
      workspaceId: event.workspaceId,
      timestamp: event.timestamp,
      epochMs,
      sequence,
    };

    const latestSession = this.latestSessionByWorkspace.get(event.workspaceId);
    if (!latestSession || candidate.epochMs >= latestSession.epochMs) {
      this.latestSessionByWorkspace.set(event.workspaceId, candidate);
      return true;
    }
    return false;
  }
}

function tabBadgeEventFromObserverEvent(input: unknown): TabBadgeEvent | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }

  if (
    record.type !== "harness/tab-badge" ||
    !isTabBadgeState(record.state) ||
    typeof record.sessionId !== "string" ||
    record.sessionId.trim() === "" ||
    typeof record.adapterName !== "string" ||
    record.adapterName.trim() === "" ||
    typeof record.workspaceId !== "string" ||
    record.workspaceId.trim() === "" ||
    typeof record.timestamp !== "string" ||
    record.timestamp.trim() === ""
  ) {
    return undefined;
  }

  return {
    type: "harness/tab-badge",
    state: record.state,
    sessionId: record.sessionId.trim(),
    adapterName: record.adapterName.trim(),
    workspaceId: record.workspaceId.trim(),
    timestamp: record.timestamp.trim(),
  };
}

function isTabBadgeState(value: unknown): value is TabBadgeEvent["state"] {
  return value === "running" || value === "awaiting-approval" || value === "completed" || value === "error";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function timestampEpochMs(timestamp: string, now: () => Date): number {
  const parsed = Date.parse(timestamp);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }
  return now().getTime();
}
