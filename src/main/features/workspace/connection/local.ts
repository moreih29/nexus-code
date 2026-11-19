import { createLogger } from "../../../../shared/log/main";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import type { AgentChannel } from "../../../infra/agent/channel";
import type { SshChannelLifecycleEvent } from "../../../infra/agent/ssh/channel";
import { AgentFsProvider } from "../../fs/bridge/agent-provider";
import type { WorkspaceContext } from "../context";
import type { WorkspaceLocalAgentCommandResolver, WorkspaceLocalChannelFactory } from "../manager";
import type { HookInfo, WorkspaceHooks } from "./hooks";
import {
  createInitialFsProvider,
  createWorkspaceRemovedError,
  type WorkspaceConnectionState,
} from "./state";

const log = createLogger("workspace");

interface LocalHookRefresh {
  promise: Promise<void>;
  resolve: () => void;
}

/** Owns local providers and their hook refreshes across agent restarts. */
export class LocalWorkspaceConnections {
  readonly localChannels = new Map<string, AgentChannel>();

  private readonly localProviderReady = new Map<string, Promise<void>>();

  /** One wait per local reconnect, until the replacement's hooks are known. */
  private readonly localHookRefreshes = new WeakMap<AgentChannel, LocalHookRefresh>();

  constructor(
    private readonly state: WorkspaceConnectionState,
    private readonly hooks: WorkspaceHooks,
    private readonly localChannelFactory: WorkspaceLocalChannelFactory,
    private readonly localAgentCommandResolver: WorkspaceLocalAgentCommandResolver,
  ) {}

  /** Releases the local channel after its workspace context is closed. */
  remove(workspaceId: string): void {
    this.localChannels.get(workspaceId)?.dispose();
    this.localChannels.delete(workspaceId);
    this.localProviderReady.delete(workspaceId);
  }

  /** Releases all remaining local channels at app shutdown. */
  close(): void {
    for (const channel of this.localChannels.values()) {
      channel.dispose();
    }
    this.localChannels.clear();
    this.localProviderReady.clear();
  }

  /** Returns the hooks for the channel about to start a chat or terminal. */
  async getSpawnHookInfo(
    workspaceId: string,
    channel: AgentChannel,
    currentChannel: () => AgentChannel | undefined,
  ): Promise<HookInfo | null> {
    let refresh = this.localHookRefreshes.get(channel);
    while (refresh) {
      await refresh.promise;
      refresh = this.localHookRefreshes.get(channel);
    }
    if (currentChannel() !== channel) {
      throw new Error(`agent channel changed for workspace: ${workspaceId}`);
    }
    return this.hooks.getHookInfo(workspaceId);
  }

  /**
   * Starts the local agent and wires the context only after the ready handshake.
   */
  async ensureLocalProviderReady(ctx: WorkspaceContext): Promise<void> {
    const meta = ctx.getMeta();
    if (meta.location.kind !== "local") {
      return;
    }

    const pending = this.localProviderReady.get(meta.id);
    if (pending) {
      await pending;
      return;
    }

    const ready = this.startLocalProvider(ctx, meta);
    this.localProviderReady.set(meta.id, ready);
    try {
      await ready;
    } catch (error) {
      if (this.localProviderReady.get(meta.id) === ready) {
        this.localProviderReady.delete(meta.id);
      }
      throw error;
    }
  }

  /**
   * Owns the explicit local boot sequence: spawn → ready → context provider.
   */
  private async startLocalProvider(ctx: WorkspaceContext, meta: WorkspaceMeta): Promise<void> {
    if (meta.location.kind !== "local") {
      return;
    }

    const command = this.localAgentCommandResolver();
    const channel = this.localChannelFactory({ ...command, rootPath: meta.location.rootPath });
    this.localChannels.set(meta.id, channel);
    const disposeLifecycleListener = channel.onLifecycle((event) => {
      this.handleLocalChannelLifecycle(meta.id, channel, event);
    });

    try {
      await channel.ready;
    } catch (error) {
      disposeLifecycleListener();
      if (this.localChannels.get(meta.id) === channel) {
        this.localChannels.delete(meta.id);
      }
      channel.dispose();
      ctx.setFsProvider(createInitialFsProvider(meta));
      throw error;
    }

    try {
      const info = await this.hooks.readHookInfo(meta.id, channel);
      if (this.localChannels.get(meta.id) === channel && !this.localHookRefreshes.has(channel)) {
        this.hooks.cacheHookInfo(meta.id, info);
      }
    } catch (err) {
      disposeLifecycleListener();
      if (this.localChannels.get(meta.id) === channel) {
        this.localChannels.delete(meta.id);
      }
      this.finishLocalHookRefresh(channel);
      channel.dispose();
      ctx.setFsProvider(createInitialFsProvider(meta));
      log.warn(`agent hook setup failed for ${meta.id}: ${(err as Error).message}`);
      throw new Error(`Agent hook setup failed: ${(err as Error).message}`, { cause: err });
    }

    // Write the PTY shim files into the workspace-specific directory.
    // On failure only the PATH priority breaks (the hook itself works via the absolute path in settings.json),
    // so warn gracefully and continue booting.
    try {
      await this.state.writeShimFiles(meta.id);
    } catch (shimErr) {
      log.warn(
        `shim file write failed for ${meta.id}; shell PATH priority may be degraded: ${(shimErr as Error).message}`,
      );
    }

    if (!this.state.isLiveContext(meta.id, ctx)) {
      disposeLifecycleListener();
      channel.dispose();
      // remove() already deleted the shim dir; this boot rewrote it.
      this.state.removeShimDirQuietly(meta.id);
      throw createWorkspaceRemovedError(meta.id);
    }

    const provider = new AgentFsProvider("local", channel, { disposeChannel: true });
    ctx.setFsProvider(provider, () => {
      disposeLifecycleListener();
      this.finishLocalHookRefresh(channel);
      provider.dispose();
      if (this.localChannels.get(meta.id) === channel) {
        this.localChannels.delete(meta.id);
      }
      this.localProviderReady.delete(meta.id);
    });
    this.state.notifyProviderReady(meta.id, provider);
  }

  /**
   * Handles terminal local channel lifecycle events and restores the inert provider.
   */
  private handleLocalChannelLifecycle(
    workspaceId: string,
    channel: AgentChannel,
    event: SshChannelLifecycleEvent,
  ): void {
    if (this.localChannels.get(workspaceId) !== channel) {
      return;
    }

    const ctx = this.state.contexts.get(workspaceId);
    if (!ctx) {
      this.localChannels.delete(workspaceId);
      this.localProviderReady.delete(workspaceId);
      this.finishLocalHookRefresh(channel);
      return;
    }

    if (event.type === "reconnecting") {
      const previous = this.localHookRefreshes.get(channel);
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      this.localHookRefreshes.set(channel, { promise, resolve });
      this.hooks.clear(workspaceId);
      previous?.resolve();
      return;
    }
    if (event.type === "ready") {
      const refresh = this.localHookRefreshes.get(channel);
      if (refresh) void this.refreshLocalHooks(workspaceId, channel, refresh);
      return;
    }
    if (event.type === "disposed") {
      this.finishLocalHookRefresh(channel);
      return;
    }

    // Teardown is reserved for genuine terminal events (`exit`, `failure`).
    // Heartbeat quality signals leave the provider and its watches wired.
    if (event.type !== "exit" && event.type !== "failure") {
      return;
    }

    this.localChannels.delete(workspaceId);
    this.localProviderReady.delete(workspaceId);
    this.finishLocalHookRefresh(channel);
    // Stale hookInfo is invalid once the channel dies — the next boot fills it again.
    // Keeping it could let a spawn right after reconnect put a dead socket path in the env.
    this.hooks.clear(workspaceId);
    ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
    // Clean up the PTY shim directory — fire-and-forget, errors are swallowed as a warn.
    this.state.removeShimDir(workspaceId).catch((err: unknown) => {
      log.warn(`shim dir removal failed for ${workspaceId}: ${(err as Error).message}`);
    });
  }

  /** Refreshes the endpoint for the process that just completed its handshake. */
  private async refreshLocalHooks(
    workspaceId: string,
    channel: AgentChannel,
    refresh: LocalHookRefresh,
  ): Promise<void> {
    try {
      const info = await this.hooks.readHookInfo(workspaceId, channel);
      if (this.localHookRefreshes.get(channel) !== refresh) return;
      this.hooks.cacheHookInfo(workspaceId, info);
      this.finishLocalHookRefresh(channel);
    } catch (error) {
      if (this.localHookRefreshes.get(channel) !== refresh) return;
      log.warn(`agent hook setup failed for ${workspaceId}: ${(error as Error).message}`);
      this.handleLocalChannelLifecycle(workspaceId, channel, {
        type: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /** Releases chat callers so they can check whether their channel is still current. */
  private finishLocalHookRefresh(channel: AgentChannel): void {
    const refresh = this.localHookRefreshes.get(channel);
    this.localHookRefreshes.delete(channel);
    refresh?.resolve();
  }
}
