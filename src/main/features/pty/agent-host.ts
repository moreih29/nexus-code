import { TextDecoder } from "node:util";
import type { AgentChannel, ChannelLifecycleEvent } from "../../infra/agent/channel";
import type { PtyHostHandle } from "./types";

type EventCallback = (args: unknown) => void;

interface AgentPtySession {
  workspaceId: string;
  tabId: string;
  decoder: TextDecoder;
}

interface WorkspaceSubscription {
  channel: AgentChannel;
  disposers: Array<() => void>;
}

export interface AgentPtyWorkspaceManager {
  /**
   * Returns the ready agent channel for a workspace, booting it if needed.
   * Throws when the workspace is not found or the channel cannot be obtained.
   */
  getAgentChannel(workspaceId: string): Promise<AgentChannel>;
  /**
   * Returns the agent channel for a workspace without throwing when the
   * workspace is not found. Returns `null` when the workspace context does
   * not exist — used by PTY paths where a missing workspace is a normal
   * racing condition rather than a bug.
   */
  tryGetAgentChannel(workspaceId: string): Promise<AgentChannel | null>;
}

/**
 * Creates the main-process PTY host that relays terminal RPCs and events
 * through the workspace-scoped Go agent channel.
 */
export function startAgentPtyHost(workspaceManager: AgentPtyWorkspaceManager): PtyHostHandle {
  return new AgentPtyHostHandle(workspaceManager);
}

/**
 * AgentPtyHostHandle owns only main-side PTY session bookkeeping; the
 * underlying AgentChannel lifecycle remains owned by WorkspaceManager.
 */
class AgentPtyHostHandle implements PtyHostHandle {
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private readonly sessions = new Map<string, AgentPtySession>();
  private readonly sessionsByWorkspace = new Map<string, Set<string>>();
  private readonly subscriptions = new Map<string, WorkspaceSubscription>();
  private disposed = false;

  constructor(private readonly workspaceManager: AgentPtyWorkspaceManager) {}

  async call(method: string, args: unknown): Promise<unknown> {
    if (this.disposed) {
      // Shutdown race: the renderer's xterm ResizeObserver (and similar
      // fire-and-forget paths) can still dispatch pty IPC after dispose()
      // runs during before-quit. The renderer already ignores rejections for
      // write/resize/kill/ack, so silently no-op those to avoid noisy
      // "Error occurred in handler for 'ipc:call'" logs at shutdown. spawn
      // returns a typed { pid } that callers depend on, so keep its throw.
      if (method === "spawn") {
        throw new Error("PTY agent host disposed");
      }
      return undefined;
    }

    const { workspaceId, tabId } = workspaceTabFromArgs(args, method);

    // For spawn we need the channel or it's a hard error; for the other
    // methods (write/resize/ack/kill) a missing workspace is a normal racing
    // condition — the workspace was removed before the renderer-side
    // fire-and-forget IPC arrived.  Use tryChannelForWorkspace so those
    // paths return undefined instead of propagating a "workspace not found"
    // throw that Electron would log as an unhandled handler error.
    if (method !== "spawn") {
      const channel = await this.tryChannelForWorkspace(workspaceId);
      if (!channel) return undefined;
      switch (method) {
        case "write":
          return channel.call("pty.write", args);
        case "resize":
          return channel.call("pty.resize", args);
        case "ack":
          return channel.call("pty.ack", ackParamsFromArgs(args, workspaceId, tabId));
        case "kill":
          return channel.call("pty.kill", args);
        default:
          throw new Error(`agentPtyHost.call: unknown method: ${method}`);
      }
    }

    const channel = await this.channelForWorkspace(workspaceId);
    return this.spawn(channel, args, workspaceId, tabId);
  }

  on(event: string, cb: EventCallback): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(cb);
    return () => listeners?.delete(cb);
  }

  isAlive(): boolean {
    return !this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Emit pty.exit for every active session before tearing down, so renderers
    // can enter a dead state rather than waiting indefinitely.
    const activeSessions = Array.from(this.sessions.values());
    for (const session of activeSessions) {
      this.emitExit(session.workspaceId, session.tabId, null);
    }
    for (const subscription of this.subscriptions.values()) {
      for (const dispose of subscription.disposers) dispose();
    }
    this.subscriptions.clear();
    this.sessions.clear();
    this.sessionsByWorkspace.clear();
    this.listeners.clear();
  }

  /**
   * Registers the session before pty.spawn so early agent data frames can be
   * decoded even if they arrive before the spawn RPC response.
   */
  private async spawn(
    channel: AgentChannel,
    args: unknown,
    workspaceId: string,
    tabId: string,
  ): Promise<unknown> {
    this.rememberSession(workspaceId, tabId);
    try {
      return await channel.call("pty.spawn", args);
    } catch (error) {
      this.deleteSession(workspaceId, tabId);
      throw error;
    }
  }

  /**
   * Terminates all active PTY sessions for the given workspace by emitting
   * pty.exit events. Called from `WorkspaceManager.remove()` *before* the
   * workspace context is deleted — this guarantees the renderer sees the
   * session deaths as a main-initiated event rather than discovering them
   * via a failed post-removal IPC round-trip.
   */
  closeWorkspaceSessions(workspaceId: string): void {
    const tabIds = Array.from(this.sessionsByWorkspace.get(workspaceId) ?? []);
    for (const tabId of tabIds) {
      this.emitExit(workspaceId, tabId, null);
    }
    // Clean up the channel subscription so no further agent events arrive
    // for this workspace after the context is gone.
    const subscription = this.subscriptions.get(workspaceId);
    if (subscription) {
      for (const dispose of subscription.disposers) dispose();
      this.subscriptions.delete(workspaceId);
    }
  }

  /**
   * Gets and subscribes the workspace channel before any PTY RPC uses it.
   * Throws when the workspace is not found.
   */
  private async channelForWorkspace(workspaceId: string): Promise<AgentChannel> {
    const channel = await this.workspaceManager.getAgentChannel(workspaceId);
    await channel.ready;
    this.subscribeWorkspace(workspaceId, channel);
    return channel;
  }

  /**
   * Like `channelForWorkspace` but returns `null` instead of throwing when
   * the workspace is not found. Used by write/resize/ack/kill where a missing
   * workspace is a normal racing condition (removal won the race).
   */
  private async tryChannelForWorkspace(workspaceId: string): Promise<AgentChannel | null> {
    const channel = await this.workspaceManager.tryGetAgentChannel(workspaceId);
    if (!channel) return null;
    await channel.ready;
    this.subscribeWorkspace(workspaceId, channel);
    return channel;
  }

  /**
   * Wires agent push events into the host-level event emitter once per
   * workspace channel.
   */
  private subscribeWorkspace(workspaceId: string, channel: AgentChannel): void {
    const existing = this.subscriptions.get(workspaceId);
    if (existing?.channel === channel) {
      return;
    }
    if (existing) {
      for (const dispose of existing.disposers) dispose();
    }

    const offData = channel.on("pty.data", (payload) => this.handleData(payload));
    const offExit = channel.on("pty.exit", (payload) => this.handleExit(payload));
    // claude.hook / agent.hookServerReady 이벤트를 PtyHostHandle.on 구독자에게 relay한다.
    // setupClaudeFeature 가 PtyHostHandle.on("agent.hookServerReady", ...) 등으로 구독한다.
    const offHookServerReady = channel.on("agent.hookServerReady", (payload) =>
      this.emit("agent.hookServerReady", { workspaceId, ...asRecord(payload) }),
    );
    const offClaudeHook = channel.on("claude.hook", (payload) =>
      this.emit("claude.hook", payload),
    );
    const offLifecycle = channel.onLifecycle((event) => {
      this.handleLifecycle(workspaceId, event);
    });
    this.subscriptions.set(workspaceId, {
      channel,
      disposers: [offData, offExit, offHookServerReady, offClaudeHook, offLifecycle],
    });
  }

  /**
   * Decodes one base64 PTY byte chunk through the session's streaming decoder.
   */
  private handleData(payload: unknown): void {
    const parsed = parseAgentDataPayload(payload);
    if (!parsed) return;

    const session = this.sessions.get(sessionKey(parsed.workspaceId, parsed.tabId));
    if (!session) return;

    const chunk = session.decoder.decode(Buffer.from(parsed.chunk, "base64"), { stream: true });
    if (chunk.length > 0) {
      this.emit("data", {
        workspaceId: parsed.workspaceId,
        tabId: parsed.tabId,
        chunk,
      });
    }
  }

  /**
   * Flushes any trailing decoder bytes before forwarding the child exit.
   */
  private handleExit(payload: unknown): void {
    const parsed = parseAgentExitPayload(payload);
    if (!parsed) return;
    this.emitExit(parsed.workspaceId, parsed.tabId, parsed.code);
  }

  /**
   * Converts terminal channel failure/exit/reconnecting into PTY exits for all
   * sessions known to belong to the workspace. Shell processes cannot survive
   * a channel reconnect, so even though the transport may recover the local
   * PTY sessions are gone — surface that to the renderer immediately so the
   * dead-terminal banner can fire without waiting for an indefinite retry
   * window. `disposed` (host-driven teardown) only clears local bookkeeping.
   */
  private handleLifecycle(workspaceId: string, event: ChannelLifecycleEvent): void {
    if (event.type === "failure" || event.type === "exit" || event.type === "reconnecting") {
      const tabIds = Array.from(this.sessionsByWorkspace.get(workspaceId) ?? []);
      for (const tabId of tabIds) {
        this.emitExit(workspaceId, tabId, null);
      }
    } else {
      this.clearWorkspaceSessions(workspaceId);
    }

    const subscription = this.subscriptions.get(workspaceId);
    if (subscription) {
      for (const dispose of subscription.disposers) dispose();
      this.subscriptions.delete(workspaceId);
    }
  }

  /**
   * Records one agent-backed PTY session and its UTF-8 streaming decoder.
   */
  private rememberSession(workspaceId: string, tabId: string): void {
    const key = sessionKey(workspaceId, tabId);
    if (!this.sessions.has(key)) {
      this.sessions.set(key, {
        workspaceId,
        tabId,
        decoder: new TextDecoder("utf-8"),
      });
    }

    let tabIds = this.sessionsByWorkspace.get(workspaceId);
    if (!tabIds) {
      tabIds = new Set();
      this.sessionsByWorkspace.set(workspaceId, tabIds);
    }
    tabIds.add(tabId);
  }

  /**
   * Emits a pty.exit and removes session state after flushing decoder tail.
   */
  private emitExit(workspaceId: string, tabId: string, code: number | null): void {
    const session = this.sessions.get(sessionKey(workspaceId, tabId));
    if (session) {
      const tail = session.decoder.decode();
      if (tail.length > 0) {
        this.emit("data", { workspaceId, tabId, chunk: tail });
      }
    }
    this.deleteSession(workspaceId, tabId);
    this.emit("exit", { workspaceId, tabId, code });
  }

  /**
   * Removes one session without emitting a renderer-visible lifecycle event.
   */
  private deleteSession(workspaceId: string, tabId: string): void {
    this.sessions.delete(sessionKey(workspaceId, tabId));
    const tabIds = this.sessionsByWorkspace.get(workspaceId);
    if (!tabIds) return;
    tabIds.delete(tabId);
    if (tabIds.size === 0) {
      this.sessionsByWorkspace.delete(workspaceId);
    }
  }

  /**
   * Clears all session records for a disposed workspace channel.
   */
  private clearWorkspaceSessions(workspaceId: string): void {
    const tabIds = Array.from(this.sessionsByWorkspace.get(workspaceId) ?? []);
    for (const tabId of tabIds) {
      this.deleteSession(workspaceId, tabId);
    }
  }

  /**
   * Emits one host-level event to registered IPC bridge listeners.
   */
  private emit(event: string, args: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb(args);
    }
  }
}

/**
 * Builds the stable key used for session and route maps.
 */
function sessionKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}

/**
 * Extracts the required workspace/tab identity from already-validated IPC args.
 */
function workspaceTabFromArgs(
  args: unknown,
  method: string,
): { workspaceId: string; tabId: string } {
  const record = asRecord(args);
  if (typeof record?.workspaceId !== "string" || typeof record.tabId !== "string") {
    throw new Error(`pty.${method} params must include workspaceId and tabId`);
  }
  return { workspaceId: record.workspaceId, tabId: record.tabId };
}

/**
 * Builds the exact pty.ack payload expected by the Go agent service.
 */
function ackParamsFromArgs(
  args: unknown,
  workspaceId: string,
  tabId: string,
): { workspaceId: string; tabId: string; bytesConsumed: number } {
  const record = asRecord(args);
  if (typeof record?.bytesConsumed !== "number") {
    throw new Error("pty.ack params must include bytesConsumed");
  }
  return { workspaceId, tabId, bytesConsumed: record.bytesConsumed };
}

/**
 * Narrows unknown values to object records.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parses a pty.data event emitted by the Go agent.
 */
function parseAgentDataPayload(
  payload: unknown,
): { workspaceId: string; tabId: string; chunk: string } | null {
  const record = asRecord(payload);
  if (
    typeof record?.workspaceId !== "string" ||
    typeof record.tabId !== "string" ||
    typeof record.chunk !== "string"
  ) {
    return null;
  }
  return {
    workspaceId: record.workspaceId,
    tabId: record.tabId,
    chunk: record.chunk,
  };
}

/**
 * Parses a pty.exit event emitted by the Go agent.
 */
function parseAgentExitPayload(
  payload: unknown,
): { workspaceId: string; tabId: string; code: number | null } | null {
  const record = asRecord(payload);
  if (typeof record?.workspaceId !== "string" || typeof record.tabId !== "string") {
    return null;
  }
  const code = typeof record.code === "number" ? record.code : null;
  return { workspaceId: record.workspaceId, tabId: record.tabId, code };
}
