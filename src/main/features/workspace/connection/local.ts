import { createAbortError } from "../../../../shared/abort";
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

export class LocalWorkspaceConnections {
  readonly localChannels = new Map<string, AgentChannel>();

  private readonly localProviderReady = new Map<string, Promise<void>>();

  private readonly localHookRefreshes = new WeakMap<AgentChannel, LocalHookRefresh>();

  constructor(
    private readonly state: WorkspaceConnectionState,
    private readonly hooks: WorkspaceHooks,
    private readonly localChannelFactory: WorkspaceLocalChannelFactory,
    private readonly localAgentCommandResolver: WorkspaceLocalAgentCommandResolver,
  ) {}

  remove(workspaceId: string): void {
    this.localChannels.get(workspaceId)?.dispose();
    this.localChannels.delete(workspaceId);
    this.localProviderReady.delete(workspaceId);
  }

  close(): void {
    for (const channel of this.localChannels.values()) {
      channel.dispose();
    }
    this.localChannels.clear();
    this.localProviderReady.clear();
  }

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

    const ownsChannel = () => this.localChannels.get(meta.id) === channel;
    const checkBoot = () => {
      if (!this.state.isLiveContext(meta.id, ctx)) throw createWorkspaceRemovedError(meta.id);
      if (!ownsChannel())
        throw createAbortError(`Agent changed while workspace ${meta.id} was starting`);
    };
    let shimStarted = false;
    try {
      await channel.ready;
      checkBoot();

      let info: HookInfo | null;
      try {
        info = await this.hooks.readHookInfo(meta.id, channel);
      } catch (error) {
        checkBoot();
        log.warn(`agent hook setup failed for ${meta.id}: ${(error as Error).message}`);
        throw new Error(`Agent hook setup failed: ${(error as Error).message}`, { cause: error });
      }
      checkBoot();
      if (!this.localHookRefreshes.has(channel)) this.hooks.cacheHookInfo(meta.id, info);

      shimStarted = true;
      try {
        await this.state.writeShimFiles(meta.id);
      } catch (error) {
        log.warn(
          `shim file write failed for ${meta.id}; shell PATH priority may be degraded: ${(error as Error).message}`,
        );
      }
      checkBoot();
    } catch (error) {
      disposeLifecycleListener();
      this.finishLocalHookRefresh(channel);
      if (ownsChannel()) {
        this.localChannels.delete(meta.id);
        this.hooks.clear(meta.id);
      }
      channel.dispose();
      if (shimStarted && !this.state.isLiveContext(meta.id, ctx)) {
        this.state.removeShimDirQuietly(meta.id);
      }
      throw error;
    }

    const provider = new AgentFsProvider("local", channel);
    ctx.setFsProvider(provider, () => {
      disposeLifecycleListener();
      this.finishLocalHookRefresh(channel);
      provider.dispose();
      channel.dispose();
      if (ownsChannel()) {
        this.localChannels.delete(meta.id);
        this.localProviderReady.delete(meta.id);
      }
    });
    this.state.notifyProviderReady(meta.id, provider);
  }

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

    if (event.type !== "exit" && event.type !== "failure") {
      return;
    }

    this.localChannels.delete(workspaceId);
    this.localProviderReady.delete(workspaceId);
    this.finishLocalHookRefresh(channel);
    this.hooks.clear(workspaceId);
    ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
    this.state.removeShimDir(workspaceId).catch((err: unknown) => {
      log.warn(`shim dir removal failed for ${workspaceId}: ${(err as Error).message}`);
    });
  }

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

  private finishLocalHookRefresh(channel: AgentChannel): void {
    const refresh = this.localHookRefreshes.get(channel);
    this.localHookRefreshes.delete(channel);
    refresh?.resolve();
  }
}
