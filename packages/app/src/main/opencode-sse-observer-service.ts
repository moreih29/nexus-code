import type { HarnessObserverEvent } from "../../../shared/src/contracts/harness-observer";
import type { WorkspaceId, WorkspaceRegistryEntry } from "../../../shared/src/contracts/workspace";
import { mapOpenCodeInputToObserverEvents } from "../../../shared/src/harness/adapters/opencode";
import { OPENCODE_HOST, resolveOpenCodePort } from "./opencode-runtime";

export interface OpenCodeWorkspaceSessionStore {
  restoreWorkspaceSession(): Promise<{ openWorkspaces: WorkspaceRegistryEntry[] }>;
}

export interface OpenCodeSseObserverServiceOptions {
  workspaceSessionStore: OpenCodeWorkspaceSessionStore;
  emitObserverEvent(event: HarnessObserverEvent): void;
  fetchFn?: typeof fetch;
  now?: () => Date;
  reconcileIntervalMs?: number;
  retryDelayMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  logger?: Pick<Console, "debug" | "error">;
}

interface WorkspaceConnection {
  workspace: WorkspaceRegistryEntry;
  controller: AbortController;
  done: Promise<void>;
}

interface SseMessage {
  event?: string;
  data: string;
}

const DEFAULT_RECONCILE_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export class OpenCodeSseObserverService {
  private readonly workspaceSessionStore: OpenCodeWorkspaceSessionStore;
  private readonly emitObserverEvent: (event: HarnessObserverEvent) => void;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly reconcileIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly logger?: Pick<Console, "debug" | "error">;

  private readonly connectionsByWorkspaceId = new Map<WorkspaceId, WorkspaceConnection>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private disposed = false;

  public constructor(options: OpenCodeSseObserverServiceOptions) {
    this.workspaceSessionStore = options.workspaceSessionStore;
    this.emitObserverEvent = options.emitObserverEvent;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.logger = options.logger;
  }

  public start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;

    void this.reconcileOnce();
    this.reconcileTimer = this.setIntervalFn(() => {
      void this.reconcileOnce();
    }, this.reconcileIntervalMs);
    const timerWithUnref = this.reconcileTimer as { unref?: () => void };
    timerWithUnref.unref?.();
  }

  public async reconcileOnce(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const session = await this.workspaceSessionStore.restoreWorkspaceSession();
    const openByWorkspaceId = new Map(session.openWorkspaces.map((workspace) => [workspace.id, workspace]));

    for (const workspaceId of Array.from(this.connectionsByWorkspaceId.keys())) {
      if (!openByWorkspaceId.has(workspaceId)) {
        this.stopWorkspaceConnection(workspaceId);
      }
    }

    for (const workspace of openByWorkspaceId.values()) {
      if (!this.connectionsByWorkspaceId.has(workspace.id)) {
        this.startWorkspaceConnection(workspace);
      }
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.reconcileTimer) {
      this.clearIntervalFn(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    for (const workspaceId of Array.from(this.connectionsByWorkspaceId.keys())) {
      this.stopWorkspaceConnection(workspaceId);
    }
  }

  public listConnectedWorkspaceIds(): WorkspaceId[] {
    return Array.from(this.connectionsByWorkspaceId.keys());
  }

  private startWorkspaceConnection(workspace: WorkspaceRegistryEntry): void {
    const controller = new AbortController();
    const done = this.runWorkspaceConnectionLoop(workspace, controller.signal).finally(() => {
      const current = this.connectionsByWorkspaceId.get(workspace.id);
      if (current?.controller === controller) {
        this.connectionsByWorkspaceId.delete(workspace.id);
      }
    });
    this.connectionsByWorkspaceId.set(workspace.id, { workspace, controller, done });
  }

  private stopWorkspaceConnection(workspaceId: WorkspaceId): void {
    const connection = this.connectionsByWorkspaceId.get(workspaceId);
    if (!connection) {
      return;
    }
    this.connectionsByWorkspaceId.delete(workspaceId);
    connection.controller.abort();
    void connection.done.catch(() => undefined);
  }

  private async runWorkspaceConnectionLoop(
    workspace: WorkspaceRegistryEntry,
    signal: AbortSignal,
  ): Promise<void> {
    const url = openCodeSseUrl(workspace.id);
    while (!signal.aborted && !this.disposed) {
      try {
        const response = await this.fetchFn(url, {
          signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!response.ok) {
          throw new Error(`OpenCode SSE responded with HTTP ${response.status}.`);
        }
        if (!response.body) {
          throw new Error("OpenCode SSE response did not include a readable body.");
        }
        await consumeOpenCodeSseStream(response.body, (message) => {
          this.handleSseMessage(workspace.id, message);
        });
      } catch (error) {
        if (signal.aborted || this.disposed || isAbortError(error)) {
          return;
        }
        this.logger?.debug?.("OpenCode SSE observer: waiting for workspace server.", {
          workspaceId: workspace.id,
          url,
          error,
        });
      }

      await abortableDelay(this.retryDelayMs, signal, this.setTimeoutFn, this.clearTimeoutFn);
    }
  }

  private handleSseMessage(workspaceId: WorkspaceId, message: SseMessage): void {
    const input = openCodeInputFromSseMessage(message);
    if (!input) {
      return;
    }
    for (const event of mapOpenCodeInputToObserverEvents(input, {
      workspaceId,
      now: this.now,
    })) {
      this.emitObserverEvent(event);
    }
  }
}

export function openCodeSseUrl(workspaceId: WorkspaceId): string {
  return `http://${OPENCODE_HOST}:${resolveOpenCodePort(workspaceId)}/event`;
}

export async function consumeOpenCodeSseStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = drainSseBuffer(buffer, onMessage);
    }
    buffer += decoder.decode();
    drainSseBuffer(`${buffer}\n\n`, onMessage);
  } finally {
    reader.releaseLock();
  }
}

export function openCodeInputFromSseMessage(message: SseMessage): unknown | undefined {
  const eventName = message.event?.trim();
  const trimmedData = message.data.trim();
  if (trimmedData === "") {
    return eventName ? { event: eventName } : undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedData) as unknown;
  } catch {
    parsed = { text: trimmedData };
  }

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const record = { ...(parsed as Record<string, unknown>) };
    if (eventName && typeof record.event !== "string") {
      record.event = eventName;
    }
    return record;
  }

  return eventName ? { event: eventName, data: parsed } : { data: parsed };
}

function drainSseBuffer(
  buffer: string,
  onMessage: (message: SseMessage) => void,
): string {
  let normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (true) {
    const boundary = normalized.indexOf("\n\n");
    if (boundary < 0) {
      return normalized;
    }

    const block = normalized.slice(0, boundary);
    normalized = normalized.slice(boundary + 2);
    const message = parseSseBlock(block);
    if (message) {
      onMessage(message);
    }
  }
}

function parseSseBlock(block: string): SseMessage | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of block.split("\n")) {
    if (rawLine === "" || rawLine.startsWith(":")) {
      continue;
    }
    const separatorIndex = rawLine.indexOf(":");
    const field = separatorIndex >= 0 ? rawLine.slice(0, separatorIndex) : rawLine;
    const value = separatorIndex >= 0 ? rawLine.slice(separatorIndex + 1).replace(/^ /, "") : "";

    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      default:
        break;
    }
  }

  if (!event && dataLines.length === 0) {
    return undefined;
  }
  return {
    event,
    data: dataLines.join("\n"),
  };
}

async function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
  setTimeoutFn: typeof setTimeout,
  clearTimeoutFn: typeof clearTimeout,
): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeoutFn(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const timerWithUnref = timer as { unref?: () => void };
    timerWithUnref.unref?.();

    const onAbort = (): void => {
      clearTimeoutFn(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
