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
} from "../../infra/agent/channel/local-channel";
import { createFsProvider } from "../fs/bridge/create-provider";
import { AgentFsProvider } from "../fs/bridge/agent-provider";
import type { FsProvider } from "../fs/bridge/provider";
import type { GlobalStorage } from "../../infra/storage/global-storage";
import type { StateService } from "../../infra/storage/state-service";
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";
import {
  type CreateSshChannelOptions,
  createSshChannel,
  type SshChannel,
  type SshChannelLifecycleEvent,
} from "../../infra/agent/ssh/channel";
import type { SshControlMaster } from "../../infra/agent/ssh/master";
import {
  type EnsureRemoteAgentOptions,
  type EnsureRemoteAgentResult,
  type EnsureRemoteLspServerOptions,
  type EnsureRemoteLspServerResult,
  type LspBootstrapProgressEvent,
  ensureRemoteAgent,
  ensureRemoteLspServer as defaultEnsureRemoteLspServer,
  type SshBootstrapDependencies,
} from "../../infra/agent/ssh/ssh-bootstrap/index";
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

  /**
   * Optional callback invoked by `remove()` before the workspace context is
   * deleted. Injected after construction (see `setPtySessionCloser`) so the
   * PTY host and WorkspaceManager can be wired without a circular import.
   * When set, remove() calls this first so PTY sessions are terminated on the
   * main side before the renderer's workspace:removed broadcast arrives —
   * eliminating the "workspace not found" errors that occur when the renderer
   * tries to kill sessions via IPC after the context is already gone.
   */
  private ptySessionCloser: ((workspaceId: string) => void) | null = null;

  private readonly contexts = new Map<string, WorkspaceContext>();
  private readonly localChannels = new Map<string, AgentChannel>();
  private readonly localProviderReady = new Map<string, Promise<void>>();
  private readonly sshChannels = new Map<string, SshChannel>();
  private readonly sshBootstraps = new Map<string, EnsureRemoteAgentResult>();
  private readonly sshProviderReady = new Map<string, Promise<void>>();
  // ControlMasters handed off from an SSH browse session, keyed by workspace
  // id, awaiting their first provider boot. Consumed by startSshProvider.
  private readonly adoptedSshMasters = new Map<string, SshControlMaster>();
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
    this.activeId = nextActiveId;
    if (savedId !== nextActiveId) {
      this.stateService.setState({ lastActiveWorkspaceId: nextActiveId });
    }
    // Kick off provider bootstrap without blocking app startup. Awaiting
    // here deadlocks an SSH workspace: auth-pty's host-key/password prompt
    // can only be answered in a window that createMainWindow opens *after*
    // init() returns. The renderer tracks progress via the
    // connection-status broadcasts; ensureProviderReady is idempotent, so
    // a later renderer-triggered call coalesces onto this same attempt.
    void this.ensureProviderReady(ctx).catch((error) => {
      console.error("[workspace] initial provider bootstrap failed", error);
    });
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
    for (const master of this.adoptedSshMasters.values()) {
      master.dispose();
    }
    this.adoptedSshMasters.clear();
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
   * Returns the workspace's filesystem provider after the underlying agent
   * channel is ready. Callers (fs IPC handlers, fs.changed subscribers) must
   * await this instead of `requireContext(id).fs` so they never receive the
   * inert provider produced by `createInitialFsProvider` before the SSH
   * bootstrap or local channel boot completes.
   */
  async getFs(id: string): Promise<FsProvider> {
    const ctx = this.requireContext(id);
    await this.ensureProviderReady(ctx);
    return ctx.fs;
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

  /**
   * Returns the ready workspace-scoped agent channel, or `null` when the
   * workspace is not found. Unlike `getAgentChannel`, this method never
   * throws for a missing workspace — callers where "workspace removed before
   * IPC arrived" is an expected racing condition should use this form.
   */
  async tryGetAgentChannel(id: string): Promise<AgentChannel | null> {
    if (!this.contexts.has(id)) return null;
    return this.getAgentChannel(id);
  }

  /**
   * Registers the PTY session closer called by `remove()` before the
   * workspace context is deleted. Wired from `main/index.ts` after both the
   * WorkspaceManager and the PTY host have been constructed — breaks the
   * circular dependency without restructuring constructors.
   */
  setPtySessionCloser(closer: (workspaceId: string) => void): void {
    this.ptySessionCloser = closer;
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Atomic SSH workspace creation: runs the SSH bootstrap (ControlMaster
   * authentication) *before* persisting the workspace to storage or
   * broadcasting to the renderer. If auth is cancelled or fails, nothing
   * is committed and the caller receives a descriptive error — the sidebar
   * never shows an orphaned entry.
   *
   * On success the workspace is committed (storage + context + broadcast)
   * and the authenticated ControlMaster is adopted so the first provider
   * boot reuses the established socket without a second credential prompt.
   *
   * Cancellation: when the user dismisses the SSH auth prompt the prompt
   * hub rejects bootstrap with AuthCancelledError, which the caller maps to
   * a `cancelled` Result — nothing is committed.
   */
  async createAndConnectSsh(opts: WorkspaceCreateOptions): Promise<WorkspaceMeta> {
    const location = normalizeCreateLocation(opts);
    if (location.kind !== "ssh") {
      throw new Error("createAndConnectSsh called for non-SSH location");
    }

    // Phase 1 — authenticate and establish ControlMaster before any commit.
    // A cancelled auth prompt rejects bootstrap with AuthCancelledError.
    const bootstrap = await this.sshBootstrap({
      host: location.host,
      user: location.user,
      port: location.port,
      identityFile: location.identityFile,
      authMode: location.authMode,
      remotePath: location.remotePath,
    });

    // Phase 2 — commit: persist, register context, broadcast.
    // Bootstrap succeeded; we now own the ControlMaster.
    let meta: WorkspaceMeta;
    try {
      meta = this.create(opts);
    } catch (error) {
      // Commit failed (e.g. storage error). Release the master so its process
      // does not leak, then surface the underlying error.
      bootstrap.dispose?.();
      throw error;
    }

    // Phase 3 — adopt the established ControlMaster so the workspace's first
    // provider boot reuses the authenticated socket (no second prompt).
    if (bootstrap.controlPath) {
      const master: SshControlMaster = {
        controlPath: bootstrap.controlPath,
        host: location.host,
        user: location.user,
        port: location.port,
        identityFile: location.identityFile,
        dispose: bootstrap.dispose ?? (() => {}),
      };
      this.adoptSshControlMaster(meta.id, master);
    } else {
      // No reusable ControlMaster (key-only auth, no multiplexing).
      bootstrap.dispose?.();
    }

    return meta;
  }

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

  /**
   * Adopts a ControlMaster handed off from an SSH directory-browse session.
   * The next SSH provider boot for this workspace reuses that socket, so the
   * user is not prompted for credentials a second time. Safe to call before
   * the provider boots; the master is consumed by startSshProvider.
   */
  adoptSshControlMaster(workspaceId: string, master: SshControlMaster): void {
    this.adoptedSshMasters.get(workspaceId)?.dispose();
    this.adoptedSshMasters.set(workspaceId, master);
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

    // Step 1 — terminate all PTY sessions for this workspace *before* the
    // context is deleted. This prevents the renderer's post-removal pty.kill
    // IPC calls from reaching `requireContext` on a missing workspace and
    // producing spurious "Error occurred in handler for 'ipc:call'" logs.
    // The PTY host emits pty.exit events for each live session so the
    // renderer's dead-terminal banner fires without waiting for IPC.
    this.ptySessionCloser?.(id);

    // Step 2 — dispose the workspace storage handle and agent channels.
    ctx.close();
    this.contexts.delete(id);
    this.localChannels.get(id)?.dispose();
    this.localChannels.delete(id);
    this.localProviderReady.delete(id);
    this.sshChannels.get(id)?.dispose();
    this.sshChannels.delete(id);
    this.sshBootstraps.delete(id);
    this.sshProviderReady.delete(id);
    // An adopted master never consumed by a provider boot would otherwise
    // leak its ssh process.
    this.adoptedSshMasters.get(id)?.dispose();
    this.adoptedSshMasters.delete(id);
    this.globalStorage.removeWorkspace(id);

    if (this.activeId === id) {
      const remaining = this.list();
      this.activeId = remaining.length > 0 ? remaining[0].id : null;
      this.stateService.setState({ lastActiveWorkspaceId: this.activeId ?? undefined });
    }

    // Step 3 — broadcast removal so the renderer and main-side subscribers
    // (gitRegistry, fsWatcher, …) clean up workspace-scoped state. By this
    // point PTY sessions are already gone so the renderer's cleanup handlers
    // arrive after the fact — idempotent, not a race.
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
    // A workspace created from a browse session inherits that session's
    // already-authenticated ControlMaster; reusing its socket lets bootstrap
    // skip the interactive auth round entirely (no second password prompt).
    const adoptedMaster = this.adoptedSshMasters.get(meta.id);
    this.adoptedSshMasters.delete(meta.id);
    let bootstrap: EnsureRemoteAgentResult;
    try {
      bootstrap = await this.sshBootstrap({
        host: meta.location.host,
        user: meta.location.user,
        port: meta.location.port,
        identityFile: meta.location.identityFile,
        authMode: meta.location.authMode,
        remotePath: meta.location.remotePath,
        cachedRemoteArch: meta.location.remoteArch,
        controlPath: adoptedMaster?.controlPath,
      });
    } catch (error) {
      // Bootstrap failed before any channel existed. Release the adopted
      // master (we own it now) and surface the error state instead of
      // leaving the renderer stuck on "connecting".
      this.broadcastConnectionStatus(meta.id, "error");
      adoptedMaster?.dispose();
      throw error;
    }
    // ensureRemoteAgent only returns a dispose handle for a master it
    // authenticated itself. When we supplied an adopted master, wire its
    // dispose in so the existing teardown paths release that socket too.
    if (adoptedMaster && !bootstrap.dispose) {
      bootstrap = { ...bootstrap, dispose: () => adoptedMaster.dispose() };
    }
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
      // channel.ready failed: bootstrap already succeeded and transferred
      // ownership of the ControlMaster to us, so we must dispose both
      // bootstrap (ControlMaster) and channel here before re-throwing.
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

    // `reconnecting` is transient — the channel may yet recover, so do not
    // drop our reference. Only terminal events trigger tear-down here.
    if (event.type === "reconnecting") {
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

    // `reconnecting` is transient — keep the channel reference so the
    // internal reconnect path can recover transparently.
    if (event.type === "reconnecting") {
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
