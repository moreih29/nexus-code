import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  rootPathFromLocation,
  type WorkspaceConnectionEventStatus,
  type WorkspaceLocation,
  WorkspaceLocationSchema,
  type WorkspaceMeta,
} from "../../../shared/types/workspace";
import type { AgentChannel } from "../../infra/agent/channel";
import {
  type LocalAgentCommand,
  resolveLocalAgentCommand,
} from "../../infra/agent/local-agent-resolver";
import {
  type CreateLocalChannelOptions,
  createLocalChannel,
} from "../../infra/agent/local-channel";
import { createFsProvider } from "../fs/bridge/create-provider";
import { AgentFsProvider } from "../fs/bridge/agent-provider";
import type { GlobalStorage } from "../../infra/storage/global-storage";
import type { StateService } from "../../infra/storage/state-service";
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";
import {
  type CreateSshChannelOptions,
  createSshChannel,
  type SshChannel,
  type SshChannelLifecycleEvent,
} from "../../infra/agent/ssh-channel";
import {
  type EnsureRemoteAgentOptions,
  type EnsureRemoteAgentResult,
  type EnsureRemoteLspServerOptions,
  type EnsureRemoteLspServerResult,
  type LspBootstrapProgressEvent,
  ensureRemoteAgent,
  ensureRemoteLspServer as defaultEnsureRemoteLspServer,
  type SshBootstrapDependencies,
} from "../../infra/agent/ssh-bootstrap";
import { WorkspaceContext } from "./context";

// ---------------------------------------------------------------------------
// Broadcast callback type — injected so the manager has no hard import on
// Electron and can be tested without a live renderer process.
// ---------------------------------------------------------------------------

export type BroadcastFn = (channelName: string, event: string, args: unknown) => void;
export type WorkspaceCreateOptions =
  | { location: WorkspaceLocation; name?: string }
  | { rootPath: string; name?: string };
type SshWorkspaceLocation = Extract<WorkspaceLocation, { kind: "ssh" }>;
export type WorkspaceSshChannelFactory = (options: CreateSshChannelOptions) => SshChannel;
export type WorkspaceSshBootstrap = (
  options: EnsureRemoteAgentOptions,
) => Promise<EnsureRemoteAgentResult>;
export type WorkspaceSshLspBootstrap = (
  options: EnsureRemoteLspServerOptions,
  dependencies?: Pick<SshBootstrapDependencies, "onProgress">,
) => Promise<EnsureRemoteLspServerResult>;
export type WorkspaceLocalChannelFactory = (options: CreateLocalChannelOptions) => AgentChannel;
export type WorkspaceLocalAgentCommandResolver = () => LocalAgentCommand;

/**
 * Builds a local workspace location from legacy create/update inputs.
 */
function localLocation(rootPath: string): WorkspaceLocation {
  return { kind: "local", rootPath };
}

/**
 * Normalizes create inputs so the manager only constructs metadata from location.
 */
function normalizeCreateLocation(opts: WorkspaceCreateOptions): WorkspaceLocation {
  return WorkspaceLocationSchema.parse(
    "location" in opts ? opts.location : localLocation(opts.rootPath),
  );
}

/**
 * Derives the default display name for local and SSH workspace locations.
 */
function defaultWorkspaceName(location: WorkspaceLocation): string {
  if (location.kind === "ssh") {
    return location.configAlias || location.host;
  }
  return path.basename(location.rootPath);
}

/**
 * Keeps the deprecated rootPath field synchronized when location changes.
 */
function normalizeWorkspaceUpdate(
  partial: Partial<Omit<WorkspaceMeta, "id" | "tabs">>,
): Partial<Omit<WorkspaceMeta, "id" | "tabs">> {
  if (partial.location) {
    const location = WorkspaceLocationSchema.parse(partial.location);
    return { ...partial, location, rootPath: rootPathFromLocation(location) };
  }
  if (partial.rootPath) {
    return { ...partial, location: localLocation(partial.rootPath) };
  }
  return partial;
}

// ---------------------------------------------------------------------------
// WorkspaceManager — global singleton, created once in main/index.ts.
// ---------------------------------------------------------------------------

export class WorkspaceManager {
  private readonly globalStorage: GlobalStorage;
  private readonly workspaceStorage: WorkspaceStorage;
  private readonly stateService: StateService;
  private readonly broadcastFn: BroadcastFn;
  private readonly sshChannelFactory: WorkspaceSshChannelFactory;
  private readonly sshBootstrap: WorkspaceSshBootstrap;
  private readonly sshLspBootstrap: WorkspaceSshLspBootstrap;
  private readonly localChannelFactory: WorkspaceLocalChannelFactory;
  private readonly localAgentCommandResolver: WorkspaceLocalAgentCommandResolver;

  private readonly contexts = new Map<string, WorkspaceContext>();
  private readonly localChannels = new Map<string, AgentChannel>();
  private readonly localProviderReady = new Map<string, Promise<void>>();
  private readonly sshChannels = new Map<string, SshChannel>();
  private readonly sshBootstraps = new Map<string, EnsureRemoteAgentResult>();
  private readonly sshProviderReady = new Map<string, Promise<void>>();
  private readonly connectionStatuses = new Map<string, WorkspaceConnectionEventStatus>();
  private activeId: string | null = null;

  constructor(
    globalStorage: GlobalStorage,
    workspaceStorage: WorkspaceStorage,
    stateService: StateService,
    broadcastFn: BroadcastFn,
    sshChannelFactory: WorkspaceSshChannelFactory = createSshChannel,
    sshBootstrap: WorkspaceSshBootstrap = ensureRemoteAgent,
    localChannelFactory: WorkspaceLocalChannelFactory = createLocalChannel,
    localAgentCommandResolver: WorkspaceLocalAgentCommandResolver = resolveLocalAgentCommand,
    sshLspBootstrap: WorkspaceSshLspBootstrap = defaultEnsureRemoteLspServer,
  ) {
    this.globalStorage = globalStorage;
    this.workspaceStorage = workspaceStorage;
    this.stateService = stateService;
    this.broadcastFn = broadcastFn;
    this.sshChannelFactory = sshChannelFactory;
    this.sshBootstrap = sshBootstrap;
    this.sshLspBootstrap = sshLspBootstrap;
    this.localChannelFactory = localChannelFactory;
    this.localAgentCommandResolver = localAgentCommandResolver;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Load all persisted workspaces into memory and restore the active workspace.
   * Call once after app.whenReady().
   */
  async init(): Promise<void> {
    const metas = this.globalStorage.listWorkspaces();
    for (const meta of metas) {
      this.workspaceStorage.openForWorkspace(meta.id);
      const ctx = new WorkspaceContext(meta, this.workspaceStorage, createInitialFsProvider(meta));
      this.contexts.set(meta.id, ctx);
    }

    const savedId = this.stateService.getState().lastActiveWorkspaceId;
    let nextActiveId: string | null = null;
    if (savedId && this.contexts.has(savedId)) {
      nextActiveId = savedId;
    } else if (metas.length > 0) {
      nextActiveId = metas[0].id;
    }

    if (!nextActiveId) {
      return;
    }

    const ctx = this.requireContext(nextActiveId);
    await this.ensureProviderReady(ctx);
    this.activeId = nextActiveId;
    if (savedId !== nextActiveId) {
      this.stateService.setState({ lastActiveWorkspaceId: nextActiveId });
    }
  }

  /**
   * Close all open workspace storage handles and the global storage.
   * Call from app.on('before-quit').
   */
  close(): void {
    for (const [id, ctx] of this.contexts) {
      ctx.close();
      this.contexts.delete(id);
      this.connectionStatuses.delete(id);
    }
    for (const channel of this.localChannels.values()) {
      channel.dispose();
    }
    this.localChannels.clear();
    this.localProviderReady.clear();
    for (const channel of this.sshChannels.values()) {
      channel.dispose();
    }
    this.sshChannels.clear();
    this.sshBootstraps.clear();
    this.sshProviderReady.clear();
    this.globalStorage.close();
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(): WorkspaceMeta[] {
    return Array.from(this.contexts.values()).map((ctx) => ctx.getMeta());
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  /**
   * Returns the ready workspace-scoped agent channel, booting it if needed.
   */
  async getAgentChannel(id: string): Promise<AgentChannel> {
    const ctx = this.requireContext(id);
    await this.ensureProviderReady(ctx);
    const channel = this.localChannels.get(id) ?? this.sshChannels.get(id);
    if (!channel) {
      throw new Error(`agent channel not available for workspace: ${id}`);
    }
    return channel;
  }

  /**
   * Returns an open workspace context or throws with the standard not-found message.
   */
  requireContext(id: string): WorkspaceContext {
    const ctx = this.contexts.get(id);
    if (!ctx) {
      throw new Error(`workspace not found: ${id}`);
    }
    return ctx;
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  create(opts: WorkspaceCreateOptions): WorkspaceMeta {
    const id = randomUUID();
    const location = normalizeCreateLocation(opts);
    const rootPath = rootPathFromLocation(location);
    const name = opts.name ?? defaultWorkspaceName(location);
    const meta: WorkspaceMeta = {
      id,
      name,
      location,
      rootPath,
      colorTone: "default",
      pinned: false,
      lastOpenedAt: new Date().toISOString(),
      tabs: [],
    };

    this.globalStorage.addWorkspace(meta);
    this.workspaceStorage.openForWorkspace(id);
    const ctx = new WorkspaceContext(meta, this.workspaceStorage, createInitialFsProvider(meta));
    ctx.setMeta(meta);
    this.contexts.set(id, ctx);

    this.broadcastFn("workspace", "changed", meta);
    return meta;
  }

  update(id: string, partial: Partial<Omit<WorkspaceMeta, "id" | "tabs">>): WorkspaceMeta {
    const ctx = this.contexts.get(id);
    if (!ctx) {
      throw new Error(`workspace not found: ${id}`);
    }
    const normalizedPartial = normalizeWorkspaceUpdate(partial);
    this.globalStorage.updateWorkspace(id, normalizedPartial);
    const updated: WorkspaceMeta = { ...ctx.getMeta(), ...normalizedPartial };
    ctx.setMeta(updated);

    this.broadcastFn("workspace", "changed", updated);
    return updated;
  }

  remove(id: string): void {
    const ctx = this.contexts.get(id);
    if (!ctx) {
      return;
    }
    ctx.close();
    this.contexts.delete(id);
    this.localChannels.get(id)?.dispose();
    this.localChannels.delete(id);
    this.localProviderReady.delete(id);
    this.sshChannels.get(id)?.dispose();
    this.sshChannels.delete(id);
    this.sshBootstraps.delete(id);
    this.sshProviderReady.delete(id);
    this.globalStorage.removeWorkspace(id);

    if (this.activeId === id) {
      const remaining = this.list();
      this.activeId = remaining.length > 0 ? remaining[0].id : null;
      this.stateService.setState({ lastActiveWorkspaceId: this.activeId ?? undefined });
    }

    this.broadcastFn("workspace", "removed", { id });
    this.connectionStatuses.delete(id);
  }

  async activate(id: string): Promise<void> {
    const ctx = this.contexts.get(id);
    if (!ctx) {
      throw new Error(`workspace not found: ${id}`);
    }

    await this.ensureProviderReady(ctx);
    this.activeId = id;
    this.stateService.setState({ lastActiveWorkspaceId: id });
  }

  async ensureRemoteLspServer(
    workspaceId: string,
    request: {
      readonly binaryName: string;
      readonly languageId: string;
      readonly args: readonly string[];
    },
    onProgress?: (event: LspBootstrapProgressEvent) => void,
  ): Promise<{ readonly binaryPath: string; readonly args: readonly string[] } | null> {
    const ctx = this.requireContext(workspaceId);
    const meta = ctx.getMeta();
    if (meta.location.kind !== "ssh") {
      return null;
    }

    await this.ensureProviderReady(ctx);
    const refreshedMeta = ctx.getMeta();
    if (refreshedMeta.location.kind !== "ssh") {
      return null;
    }

    const bootstrap = this.sshBootstraps.get(workspaceId);
    const result = await this.sshLspBootstrap(
      {
        host: refreshedMeta.location.host,
        user: refreshedMeta.location.user,
        port: refreshedMeta.location.port,
        identityFile: refreshedMeta.location.identityFile,
        authMode: refreshedMeta.location.authMode,
        remotePath: refreshedMeta.location.remotePath,
        cachedRemoteArch: refreshedMeta.location.remoteArch,
        controlPath: bootstrap?.controlPath,
        binaryName: request.binaryName,
        languageId: request.languageId,
      },
      { onProgress },
    );
    result.dispose?.();
    return { binaryPath: result.binaryPath, args: result.args };
  }

  /**
   * Boots the workspace-scoped agent channel before exposing the workspace as active.
   */
  private async ensureProviderReady(ctx: WorkspaceContext): Promise<void> {
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      await this.ensureLocalProviderReady(ctx);
      return;
    }
    await this.ensureSshProviderReady(ctx);
  }

  /**
   * Starts the local agent and wires the context only after the ready handshake.
   */
  private async ensureLocalProviderReady(ctx: WorkspaceContext): Promise<void> {
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

    const provider = new AgentFsProvider("local", channel, { disposeChannel: true });
    ctx.setFsProvider(provider, () => {
      disposeLifecycleListener();
      provider.dispose();
      if (this.localChannels.get(meta.id) === channel) {
        this.localChannels.delete(meta.id);
      }
      this.localProviderReady.delete(meta.id);
    });
  }

  /**
   * Lazily connects one SSH channel per workspace and injects it into the context.
   */
  private async ensureSshProviderReady(ctx: WorkspaceContext): Promise<void> {
    const meta = ctx.getMeta();
    if (meta.location.kind !== "ssh") {
      return;
    }

    const pending = this.sshProviderReady.get(meta.id);
    if (pending) {
      await pending;
      return;
    }

    const ready = this.startSshProvider(ctx, meta);
    this.sshProviderReady.set(meta.id, ready);
    try {
      await ready;
    } catch (error) {
      if (this.sshProviderReady.get(meta.id) === ready) {
        this.sshProviderReady.delete(meta.id);
      }
      throw error;
    }
  }

  /**
   * Owns the explicit SSH boot sequence: bootstrap → spawn → ready → context provider.
   */
  private async startSshProvider(ctx: WorkspaceContext, meta: WorkspaceMeta): Promise<void> {
    if (meta.location.kind !== "ssh") {
      return;
    }

    this.broadcastConnectionStatus(meta.id, "connecting");
    const bootstrap = await this.sshBootstrap({
      host: meta.location.host,
      user: meta.location.user,
      port: meta.location.port,
      identityFile: meta.location.identityFile,
      authMode: meta.location.authMode,
      remotePath: meta.location.remotePath,
      cachedRemoteArch: meta.location.remoteArch,
    });
    this.sshBootstraps.set(meta.id, bootstrap);
    let providerMeta = meta;
    if (!meta.location.remoteArch) {
      providerMeta = {
        ...meta,
        location: { ...meta.location, remoteArch: bootstrap.platform },
      };
      this.globalStorage.updateWorkspace(meta.id, { location: providerMeta.location });
      ctx.setMeta(providerMeta);
      this.broadcastFn("workspace", "changed", providerMeta);
    }
    const channel = this.sshChannelFactory(
      sshChannelOptionsFromLocation(
        { ...meta.location, remoteArch: bootstrap.platform },
        bootstrap.remoteCommand,
        bootstrap.controlPath,
      ),
    );
    this.sshChannels.set(meta.id, channel);
    const disposeLifecycleListener = channel.onLifecycle((event) => {
      this.handleSshChannelLifecycle(meta.id, channel, event);
    });

    try {
      await channel.ready;
    } catch (error) {
      disposeLifecycleListener();
      this.broadcastConnectionStatus(meta.id, "error");
      if (this.sshChannels.get(meta.id) === channel) {
        this.sshChannels.delete(meta.id);
      }
      this.sshBootstraps.delete(meta.id);
      bootstrap.dispose?.();
      channel.dispose();
      ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
      if (isAbortError(error) && this.sshChannels.get(meta.id) !== channel) {
        throw error;
      }
      throw error;
    }

    ctx.setFsProvider(createFsProvider(providerMeta, channel), () => {
      disposeLifecycleListener();
      channel.dispose();
      bootstrap.dispose?.();
      if (this.sshChannels.get(meta.id) === channel) {
        this.sshChannels.delete(meta.id);
      }
      this.sshBootstraps.delete(meta.id);
      this.sshProviderReady.delete(meta.id);
      if (this.connectionStatuses.get(meta.id) !== "error") {
        this.broadcastConnectionStatus(meta.id, "disconnected");
      }
    });
    this.broadcastConnectionStatus(meta.id, "connected");
  }

  /**
   * Broadcasts a workspace connection status only when it actually changes.
   */
  private broadcastConnectionStatus(
    workspaceId: string,
    status: WorkspaceConnectionEventStatus,
  ): void {
    if (this.connectionStatuses.get(workspaceId) === status) {
      return;
    }
    this.connectionStatuses.set(workspaceId, status);
    this.broadcastFn("workspace", "connectionChanged", { workspaceId, status });
  }

  /**
   * Handles terminal SSH channel lifecycle events and restores the inert SSH provider.
   */
  private handleSshChannelLifecycle(
    workspaceId: string,
    channel: SshChannel,
    event: SshChannelLifecycleEvent,
  ): void {
    if (this.sshChannels.get(workspaceId) !== channel) {
      return;
    }

    const ctx = this.contexts.get(workspaceId);
    if (!ctx) {
      this.sshChannels.delete(workspaceId);
      this.sshBootstraps.delete(workspaceId);
      return;
    }

    if (event.type === "failure") {
      this.broadcastConnectionStatus(workspaceId, "error");
    }

    this.sshChannels.delete(workspaceId);
    this.sshBootstraps.delete(workspaceId);
    this.sshProviderReady.delete(workspaceId);
    ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
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

    const ctx = this.contexts.get(workspaceId);
    if (!ctx) {
      this.localChannels.delete(workspaceId);
      this.localProviderReady.delete(workspaceId);
      return;
    }

    if (event.type !== "disposed") {
      this.localChannels.delete(workspaceId);
      this.localProviderReady.delete(workspaceId);
      ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
    }
  }
}

/**
 * Builds an inert provider for unopened workspaces. Activation replaces it
 * only after the workspace agent has completed its ready handshake.
 */
function createInitialFsProvider(meta: WorkspaceMeta): AgentFsProvider {
  if (meta.location.kind === "local") {
    return new AgentFsProvider("local");
  }
  return createFsProvider(meta) as AgentFsProvider;
}

/**
 * Builds the SSH channel options used when activating a remote workspace.
 */
function sshChannelOptionsFromLocation(
  location: SshWorkspaceLocation,
  remoteCommand: string,
  controlPath?: string,
): CreateSshChannelOptions {
  return {
    host: location.host,
    user: location.user,
    port: location.port,
    identityFile: location.identityFile,
    authMode: location.authMode,
    remoteCommand,
    controlPath,
  };
}

/**
 * Detects channel disposal errors so workspace removal does not look like SSH failure.
 */
function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}
