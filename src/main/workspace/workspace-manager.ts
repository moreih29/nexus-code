import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  rootPathFromLocation,
  type WorkspaceConnectionEventStatus,
  type WorkspaceLocation,
  WorkspaceLocationSchema,
  type WorkspaceMeta,
} from "../../shared/types/workspace";
import { createFsProvider } from "../fs/provider/factory";
import type { GlobalStorage } from "../storage/global-storage";
import type { StateService } from "../storage/state-service";
import type { WorkspaceStorage } from "../storage/workspace-storage";
import {
  type CreateSshChannelOptions,
  createSshChannel,
  type SshChannel,
  type SshChannelLifecycleEvent,
} from "../agent/ssh-channel";
import {
  type EnsureRemoteAgentOptions,
  type EnsureRemoteAgentResult,
  ensureRemoteAgent,
} from "../agent/ssh-bootstrap";
import { WorkspaceContext } from "./workspace-context";

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

  private readonly contexts = new Map<string, WorkspaceContext>();
  private readonly sshChannels = new Map<string, SshChannel>();
  private readonly connectionStatuses = new Map<string, WorkspaceConnectionEventStatus>();
  private activeId: string | null = null;

  constructor(
    globalStorage: GlobalStorage,
    workspaceStorage: WorkspaceStorage,
    stateService: StateService,
    broadcastFn: BroadcastFn,
    sshChannelFactory: WorkspaceSshChannelFactory = createSshChannel,
    sshBootstrap: WorkspaceSshBootstrap = ensureRemoteAgent,
  ) {
    this.globalStorage = globalStorage;
    this.workspaceStorage = workspaceStorage;
    this.stateService = stateService;
    this.broadcastFn = broadcastFn;
    this.sshChannelFactory = sshChannelFactory;
    this.sshBootstrap = sshBootstrap;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Load all persisted workspaces into memory and restore the active workspace.
   * Call once after app.whenReady().
   */
  init(): void {
    const metas = this.globalStorage.listWorkspaces();
    for (const meta of metas) {
      this.workspaceStorage.openForWorkspace(meta.id);
      const ctx = new WorkspaceContext(meta, this.workspaceStorage, createFsProvider(meta));
      this.contexts.set(meta.id, ctx);
    }

    const savedId = this.stateService.getState().lastActiveWorkspaceId;
    if (savedId && this.contexts.has(savedId)) {
      this.activeId = savedId;
    } else if (metas.length > 0) {
      this.activeId = metas[0].id;
      this.stateService.setState({ lastActiveWorkspaceId: this.activeId });
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
    const ctx = new WorkspaceContext(meta, this.workspaceStorage, createFsProvider(meta));
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

    if (ctx.getMeta().location.kind === "ssh") {
      await this.ensureSshProviderReady(ctx);
    }
    this.activeId = id;
    this.stateService.setState({ lastActiveWorkspaceId: id });
  }

  /**
   * Lazily connects one SSH channel per workspace and injects it into the context.
   */
  private async ensureSshProviderReady(ctx: WorkspaceContext): Promise<void> {
    const meta = ctx.getMeta();
    if (meta.location.kind !== "ssh") {
      return;
    }

    let channel = this.sshChannels.get(meta.id);
    if (!channel) {
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
      if (!meta.location.remoteArch) {
        const updatedMeta: WorkspaceMeta = {
          ...meta,
          location: { ...meta.location, remoteArch: bootstrap.platform },
        };
        this.globalStorage.updateWorkspace(meta.id, { location: updatedMeta.location });
        ctx.setMeta(updatedMeta);
        this.broadcastFn("workspace", "changed", updatedMeta);
      }
      const nextChannel = this.sshChannelFactory(
        sshChannelOptionsFromLocation(
          { ...meta.location, remoteArch: bootstrap.platform },
          bootstrap.remoteCommand,
          bootstrap.controlPath,
        ),
      );
      channel = nextChannel;
      this.sshChannels.set(meta.id, channel);
      const disposeLifecycleListener = nextChannel.onLifecycle((event) => {
        this.handleSshChannelLifecycle(meta.id, nextChannel, event);
      });
      ctx.setFsProvider(createFsProvider(meta, nextChannel), () => {
        disposeLifecycleListener();
        nextChannel.dispose();
        bootstrap.dispose?.();
        if (this.sshChannels.get(meta.id) === nextChannel) {
          this.sshChannels.delete(meta.id);
        }
        if (this.connectionStatuses.get(meta.id) !== "error") {
          this.broadcastConnectionStatus(meta.id, "disconnected");
        }
      });
    }

    try {
      await channel.ready;
      this.broadcastConnectionStatus(meta.id, "connected");
    } catch (error) {
      if (isAbortError(error) && this.sshChannels.get(meta.id) !== channel) {
        throw error;
      }
      this.broadcastConnectionStatus(meta.id, "error");
      if (this.sshChannels.get(meta.id) === channel) {
        this.sshChannels.delete(meta.id);
        ctx.setFsProvider(createFsProvider(meta));
      }
      throw error;
    }
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
      return;
    }

    if (event.type === "failure") {
      this.broadcastConnectionStatus(workspaceId, "error");
    }

    this.sshChannels.delete(workspaceId);
    ctx.setFsProvider(createFsProvider(ctx.getMeta()));
  }
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
