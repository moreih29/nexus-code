import { TextDecoder } from "node:util";
import { createLogger } from "../../../shared/log/main";
import type { AgentChannel, ChannelLifecycleEvent } from "../../infra/agent/channel";
import type { HookInfo } from "../workspace/manager";
import { tabHookToken } from "../workspace/tab-token";
import type { PtyHostHandle } from "./types";

const log = createLogger("agent-host");

const KILL_EXIT_WAIT_MS = 3_000;

type EventCallback = (args: unknown) => void;

interface AgentSpawnResult {
  pid: number;
  attached?: boolean;
}

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
  getAgentChannel(workspaceId: string): Promise<AgentChannel>;
  tryGetAgentChannel(workspaceId: string): Promise<AgentChannel | null>;
  getSpawnHookInfo?(workspaceId: string, channel: AgentChannel): Promise<HookInfo | null>;
  onProviderReady?(listener: (workspaceId: string) => void): () => void;
}

export interface AgentPtyHostOptions {
  readonly knownTerminalTabs?: (workspaceId: string) => ReadonlySet<string>;
}

export function startAgentPtyHost(
  workspaceManager: AgentPtyWorkspaceManager,
  options: AgentPtyHostOptions = {},
): PtyHostHandle {
  return new AgentPtyHostHandle(workspaceManager, options);
}

class AgentPtyHostHandle implements PtyHostHandle {
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private readonly sessions = new Map<string, AgentPtySession>();
  private readonly sessionsByWorkspace = new Map<string, Set<string>>();
  private readonly subscriptions = new Map<string, WorkspaceSubscription>();
  private readonly heldWorkspaces = new Set<string>();
  private readonly unwanted = new Map<string, Set<string>>();
  private readonly tabOps = new Map<string, Promise<unknown>>();
  private readonly spawning = new Set<string>();
  private readonly exitWaiters = new Map<string, () => void>();
  private disposed = false;
  private readonly disposeProviderReady: () => void;

  constructor(
    private readonly workspaceManager: AgentPtyWorkspaceManager,
    private readonly options: AgentPtyHostOptions = {},
  ) {
    this.disposeProviderReady =
      workspaceManager.onProviderReady?.((workspaceId) => {
        if (this.disposed) return;
        void this.tryChannelForWorkspace(workspaceId)
          .then((channel) => {
            if (!channel || this.disposed || this.heldWorkspaces.has(workspaceId)) return;
            return this.syncSessions(workspaceId, channel, new Set());
          })
          .catch((err: unknown) => {
            log.warn(`subscribe failed for ${workspaceId}: ${(err as Error).message}`);
          });
      }) ?? (() => {});
  }

  async call(method: string, args: unknown): Promise<unknown> {
    if (this.disposed) {
      if (method === "spawn") {
        throw new Error("PTY agent host disposed");
      }
      return undefined;
    }

    const { workspaceId, tabId } = workspaceTabFromArgs(args, method);

    if (method === "spawn") return this.spawn(args, workspaceId, tabId);
    if (method === "kill") return this.kill(workspaceId, tabId);

    const channel = await this.tryChannelForWorkspace(workspaceId);
    if (!channel) return undefined;

    if (method === "write" && this.heldWorkspaces.has(workspaceId)) {
      return undefined;
    }

    switch (method) {
      case "write":
        return channel.call("pty.write", args);
      case "resize":
        return channel.call("pty.resize", args);
      case "ack":
        return channel.call("pty.ack", ackParamsFromArgs(args, workspaceId, tabId));
      case "foregroundProcess":
        return channel.call("pty.foregroundProcess", args);
      default:
        throw new Error(`agentPtyHost.call: unknown method: ${method}`);
    }
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
    this.disposeProviderReady();
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
    this.heldWorkspaces.clear();
    this.unwanted.clear();
    for (const resolve of this.exitWaiters.values()) resolve();
    this.exitWaiters.clear();
    this.listeners.clear();
  }

  private spawn(
    args: unknown,
    workspaceId: string,
    tabId: string,
  ): Promise<{ pid: number; attached?: boolean }> {
    const key = sessionKey(workspaceId, tabId);
    const wasUnwanted = this.isUnwanted(workspaceId, tabId);
    this.settleUnwanted(workspaceId, tabId);
    this.spawning.add(key);
    let sent = false;
    const run = this.runTabOp(key, async () => {
      if (this.isUnwanted(workspaceId, tabId)) {
        throw new Error("terminal closed before it started");
      }
      const channel = await this.channelForWorkspace(workspaceId);
      if (this.isUnwanted(workspaceId, tabId)) {
        throw new Error("terminal closed before it started");
      }
      const spawn = args as { env?: Record<string, string> };
      const env = spawn.env;
      const hooks =
        env?.NEXUS_WRAPPER_SELF_DIR && this.workspaceManager.getSpawnHookInfo
          ? await this.workspaceManager.getSpawnHookInfo(workspaceId, channel)
          : null;
      if (this.isUnwanted(workspaceId, tabId)) {
        throw new Error("terminal closed before it started");
      }
      this.rememberSession(workspaceId, tabId);
      let result: AgentSpawnResult;
      try {
        sent = true;
        result = await channel.call<AgentSpawnResult>(
          "pty.spawn",
          hooks
            ? {
                ...spawn,
                env: {
                  ...env,
                  NEXUS_AGENT_SOCKET: hooks.socketPath,
                  NEXUS_HOOK_TOKEN: tabHookToken(hooks, workspaceId, tabId),
                },
              }
            : args,
        );
      } catch (error) {
        this.deleteSession(workspaceId, tabId);
        throw error;
      }
      if (result.attached && this.sessions.has(key)) {
        channel.call("pty.replay", { workspaceId, tabId }).catch((err) => {
          log.warn(`pty.replay failed for ${workspaceId}:${tabId}: ${(err as Error).message}`);
        });
      }
      return result.attached ? { pid: result.pid, attached: true } : { pid: result.pid };
    });
    void run.then(
      () => this.spawning.delete(key),
      () => {
        this.spawning.delete(key);
        if (wasUnwanted || sent) this.markUnwanted(workspaceId, tabId);
      },
    );
    return run;
  }

  private async kill(workspaceId: string, tabId: string): Promise<undefined> {
    this.markUnwanted(workspaceId, tabId);
    this.deleteSession(workspaceId, tabId);
    await this.runTabOp(sessionKey(workspaceId, tabId), () =>
      this.sendKill(workspaceId, tabId, () => this.tryChannelForWorkspace(workspaceId)),
    );
    return undefined;
  }

  private async sendKill(
    workspaceId: string,
    tabId: string,
    getChannel: () => Promise<AgentChannel | null>,
  ): Promise<boolean> {
    try {
      const channel = await getChannel();
      if (!channel) {
        this.settleUnwanted(workspaceId, tabId);
        return false;
      }
      await channel.call("pty.kill", { workspaceId, tabId });
      this.settleUnwanted(workspaceId, tabId);
      return true;
    } catch (err) {
      log.warn(
        `pty.kill failed for ${workspaceId}:${tabId}; sent again once the agent is reached: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private async killListedSession(
    workspaceId: string,
    tabId: string,
    channel: AgentChannel,
  ): Promise<void> {
    const key = sessionKey(workspaceId, tabId);
    let timer: NodeJS.Timeout | undefined;
    const exited = new Promise<void>((resolve) => {
      this.exitWaiters.set(key, resolve);
      timer = setTimeout(resolve, KILL_EXIT_WAIT_MS);
    });
    try {
      if (await this.sendKill(workspaceId, tabId, async () => channel)) await exited;
    } finally {
      clearTimeout(timer);
      this.exitWaiters.delete(key);
    }
  }

  private runTabOp<T>(key: string, op: () => Promise<T>): Promise<T> {
    const previous = this.tabOps.get(key) ?? Promise.resolve();
    const run = previous.then(op, op);
    const settled = run.then(
      () => {},
      () => {},
    );
    this.tabOps.set(key, settled);
    void settled.then(() => {
      if (this.tabOps.get(key) === settled) this.tabOps.delete(key);
    });
    return run;
  }

  private isUnwanted(workspaceId: string, tabId: string): boolean {
    return this.unwanted.get(workspaceId)?.has(tabId) === true;
  }

  private markUnwanted(workspaceId: string, tabId: string): void {
    let tabIds = this.unwanted.get(workspaceId);
    if (!tabIds) {
      tabIds = new Set();
      this.unwanted.set(workspaceId, tabIds);
    }
    tabIds.add(tabId);
  }

  private settleUnwanted(workspaceId: string, tabId: string): void {
    const tabIds = this.unwanted.get(workspaceId);
    if (!tabIds) return;
    tabIds.delete(tabId);
    if (tabIds.size === 0) this.unwanted.delete(workspaceId);
  }

  private endSession(workspaceId: string, tabId: string): void {
    this.markUnwanted(workspaceId, tabId);
    this.emitExit(workspaceId, tabId, null);
  }

  hasWorkspaceSessions(workspaceId: string): boolean {
    if (this.sessionsByWorkspace.get(workspaceId)?.size) return true;
    const prefix = sessionKey(workspaceId, "");
    return [...this.spawning].some((key) => key.startsWith(prefix));
  }

  closeWorkspaceSessions(workspaceId: string): void {
    const tabIds = Array.from(this.sessionsByWorkspace.get(workspaceId) ?? []);
    for (const tabId of tabIds) {
      this.emitExit(workspaceId, tabId, null);
    }
    this.heldWorkspaces.delete(workspaceId);
    this.unwanted.delete(workspaceId);
    const subscription = this.subscriptions.get(workspaceId);
    if (subscription) {
      for (const dispose of subscription.disposers) dispose();
      this.subscriptions.delete(workspaceId);
    }
  }

  async restoreAfterReauth(workspaceId: string): Promise<void> {
    const channel = await this.workspaceManager.tryGetAgentChannel(workspaceId);
    if (!channel) {
      this.releaseHeld(workspaceId);
      return;
    }
    await channel.ready;
    this.subscribeWorkspace(workspaceId, channel);
    if (!this.heldWorkspaces.has(workspaceId)) return;
    this.heldWorkspaces.delete(workspaceId);
    await this.syncSessions(workspaceId, channel, this.liveTabIds(workspaceId));
  }

  releaseHeld(workspaceId: string): void {
    if (!this.heldWorkspaces.has(workspaceId)) return;
    this.heldWorkspaces.delete(workspaceId);
    for (const tabId of this.liveTabIds(workspaceId)) {
      this.emit("expired", { workspaceId, tabId });
      this.endSession(workspaceId, tabId);
    }
  }

  private async channelForWorkspace(workspaceId: string): Promise<AgentChannel> {
    const channel = await this.workspaceManager.getAgentChannel(workspaceId);
    await channel.ready;
    this.subscribeWorkspace(workspaceId, channel);
    return channel;
  }

  private async tryChannelForWorkspace(workspaceId: string): Promise<AgentChannel | null> {
    const channel = await this.workspaceManager.tryGetAgentChannel(workspaceId);
    if (!channel) return null;
    await channel.ready;
    this.subscribeWorkspace(workspaceId, channel);
    return channel;
  }

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
    const offClaudeHook = channel.on("claude.hook", (payload) => {
      const claimed = (payload as { workspaceId?: unknown } | null)?.workspaceId;
      if (claimed !== workspaceId) {
        log.warn(
          `Dropped claude.hook for workspace ${String(claimed)} from ${workspaceId}'s agent`,
        );
        return;
      }
      this.emit("claude.hook", payload);
    });
    const offClaudeHookGone = channel.on("claude.hookGone", (payload) => {
      const claimed = (payload as { workspaceId?: unknown } | null)?.workspaceId;
      if (claimed !== workspaceId) {
        log.warn(
          `Dropped claude.hookGone for workspace ${String(claimed)} from ${workspaceId}'s agent`,
        );
        return;
      }
      this.emit("claude.hookGone", payload);
    });
    const offCliRequest = channel.on("cli.request", (payload) => {
      const claimed = (payload as { workspaceId?: unknown } | null)?.workspaceId;
      if (claimed !== workspaceId) {
        log.warn(
          `Dropped cli.request for workspace ${String(claimed)} from ${workspaceId}'s agent`,
        );
        return;
      }
      this.emit("cli.request", payload);
    });
    const offCliCancel = channel.on("cli.cancel", (payload) => {
      const claimed = (payload as { workspaceId?: unknown } | null)?.workspaceId;
      if (claimed !== workspaceId) {
        log.warn(`Dropped cli.cancel for workspace ${String(claimed)} from ${workspaceId}'s agent`);
        return;
      }
      this.emit("cli.cancel", payload);
    });
    const offLifecycle = channel.onLifecycle((event) => {
      this.handleLifecycle(workspaceId, event);
    });
    this.subscriptions.set(workspaceId, {
      channel,
      disposers: [
        offData,
        offExit,
        offClaudeHook,
        offClaudeHookGone,
        offCliRequest,
        offCliCancel,
        offLifecycle,
      ],
    });
  }

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
        ...(parsed.replay ? { replay: true } : {}),
      });
    }
  }

  private handleExit(payload: unknown): void {
    const parsed = parseAgentExitPayload(payload);
    if (!parsed) return;
    const key = sessionKey(parsed.workspaceId, parsed.tabId);
    this.settleUnwanted(parsed.workspaceId, parsed.tabId);
    const waiter = this.exitWaiters.get(key);
    if (waiter) {
      waiter();
      if (this.spawning.has(key) && !this.sessions.has(key)) return;
    }
    this.emitExit(parsed.workspaceId, parsed.tabId, parsed.code);
  }

  private handleLifecycle(workspaceId: string, event: ChannelLifecycleEvent): void {
    if (event.type === "degraded") {
      this.emit("degraded", { workspaceId });
      return;
    }

    if (event.type === "degraded-recovered") {
      this.emit("degraded-recovered", { workspaceId });
      return;
    }

    if (event.type === "reconnecting") {
      if (event.hadEpoch) {
        const tabIds = Array.from(this.sessionsByWorkspace.get(workspaceId) ?? []);
        if (tabIds.length > 0) {
          this.heldWorkspaces.add(workspaceId);
          for (const tabId of tabIds) {
            this.emit("held", { workspaceId, tabId });
          }
        }
      } else {
        const tabIds = Array.from(this.sessionsByWorkspace.get(workspaceId) ?? []);
        for (const tabId of tabIds) {
          this.emitExit(workspaceId, tabId, null);
        }
      }
      return;
    }

    if (event.type === "ready") {
      const held = this.heldWorkspaces.has(workspaceId)
        ? this.liveTabIds(workspaceId)
        : new Set<string>();
      this.heldWorkspaces.delete(workspaceId);
      const subscription = this.subscriptions.get(workspaceId);
      if (subscription) {
        void this.syncSessions(workspaceId, subscription.channel, held);
      }
      return;
    }

    if (event.type === "held-then-expired") {
      if (this.heldWorkspaces.has(workspaceId)) {
        this.heldWorkspaces.delete(workspaceId);
        const tabIds = Array.from(this.sessionsByWorkspace.get(workspaceId) ?? []);
        for (const tabId of tabIds) {
          this.emit("expired", { workspaceId, tabId });
          this.emitExit(workspaceId, tabId, null);
        }
      }
      this.emit("held-then-expired", { workspaceId });
      const sub = this.subscriptions.get(workspaceId);
      if (sub) {
        for (const dispose of sub.disposers) dispose();
        this.subscriptions.delete(workspaceId);
      }
      return;
    }

    if (event.type === "failure" || event.type === "exit") {
      const subscription = this.subscriptions.get(workspaceId);
      if (subscription) {
        for (const dispose of subscription.disposers) dispose();
        this.subscriptions.delete(workspaceId);
      }

      if (this.heldWorkspaces.has(workspaceId)) {
        return;
      }

      for (const tabId of this.liveTabIds(workspaceId)) {
        this.endSession(workspaceId, tabId);
      }
    }
  }

  private async syncSessions(
    workspaceId: string,
    channel: AgentChannel,
    held: ReadonlySet<string>,
  ): Promise<void> {
    let aliveTabs: Set<string>;
    try {
      const result = await channel.call<{
        sessions: Array<{ workspaceId: string; tabId: string }>;
      }>("session.list", { workspaceId });
      aliveTabs = new Set(
        (result.sessions ?? []).filter((s) => s.workspaceId === workspaceId).map((s) => s.tabId),
      );
    } catch (err) {
      const message = (err as Error).message;
      if (held.size === 0) {
        log.warn(
          `session.list failed for workspace ${workspaceId}; sessions no tab wants are killed once it answers: ${message}`,
        );
        return;
      }
      if (this.heldWorkspaces.has(workspaceId)) {
        log.warn(
          `session.list failed for workspace ${workspaceId} after reattach; tabs held again: ${message}`,
        );
        return;
      }
      log.warn(
        `session.list failed for workspace ${workspaceId} after reattach; ending held sessions: ${message}`,
      );
      for (const tabId of held) {
        if (!this.sessions.has(sessionKey(workspaceId, tabId))) continue;
        this.emit("expired", { workspaceId, tabId });
        this.emitExit(workspaceId, tabId, null);
      }
      return;
    }

    this.restoreHeldSessions(workspaceId, channel, held, aliveTabs);
    this.killUnwantedSessions(workspaceId, channel, aliveTabs);
  }

  private restoreHeldSessions(
    workspaceId: string,
    channel: AgentChannel,
    heldTabIds: ReadonlySet<string>,
    aliveTabs: ReadonlySet<string>,
  ): void {
    for (const tabId of heldTabIds) {
      const key = sessionKey(workspaceId, tabId);
      if (!this.sessions.has(key)) continue;
      if (this.spawning.has(key)) {
        this.emit("restored", { workspaceId, tabId, withReplay: false });
        continue;
      }
      if (aliveTabs.has(tabId)) {
        this.emit("data", { workspaceId, tabId, chunk: "\x1bc" });
        this.emit("restored", { workspaceId, tabId, withReplay: true });
        const session = this.sessions.get(key);
        if (session) {
          session.decoder = new TextDecoder("utf-8");
        }
        channel
          .call("pty.replay", { workspaceId, tabId })
          .then(() => this.emit("replayed", { workspaceId, tabId }))
          .catch((err) => {
            log.warn(`pty.replay failed for ${workspaceId}:${tabId}: ${(err as Error).message}`);
          });
      } else {
        this.emit("data", { workspaceId, tabId, chunk: "\x1bc" });
        this.emit("restored", { workspaceId, tabId, withReplay: false });
        this.emitExit(workspaceId, tabId, null);
      }
    }
  }

  private killUnwantedSessions(
    workspaceId: string,
    channel: AgentChannel,
    aliveTabs: ReadonlySet<string>,
  ): void {
    for (const tabId of Array.from(this.unwanted.get(workspaceId) ?? [])) {
      if (!aliveTabs.has(tabId)) this.settleUnwanted(workspaceId, tabId);
    }
    const known = this.options.knownTerminalTabs?.(workspaceId);
    for (const tabId of aliveTabs) {
      const key = sessionKey(workspaceId, tabId);
      if (this.sessions.has(key) || this.spawning.has(key)) continue;
      const tabless = known !== undefined && !known.has(tabId);
      if (!tabless && !this.isUnwanted(workspaceId, tabId)) continue;
      log.info(`killing ${workspaceId}:${tabId}, a session no tab wants`);
      this.markUnwanted(workspaceId, tabId);
      void this.runTabOp(key, () => this.killListedSession(workspaceId, tabId, channel));
    }
  }

  private liveTabIds(workspaceId: string): Set<string> {
    return new Set(this.sessionsByWorkspace.get(workspaceId) ?? []);
  }

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

  private deleteSession(workspaceId: string, tabId: string): void {
    this.sessions.delete(sessionKey(workspaceId, tabId));
    const tabIds = this.sessionsByWorkspace.get(workspaceId);
    if (!tabIds) return;
    tabIds.delete(tabId);
    if (tabIds.size === 0) {
      this.sessionsByWorkspace.delete(workspaceId);
    }
  }

  private emit(event: string, args: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb(args);
    }
  }
}

function sessionKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAgentDataPayload(
  payload: unknown,
): { workspaceId: string; tabId: string; chunk: string; replay: boolean } | null {
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
    replay: record.replay === true,
  };
}

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
