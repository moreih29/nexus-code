import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentManifestSchema } from "../../../shared/agent/manifest";
import { createLogger } from "../../../shared/log/main";
import {
  attachHostOf,
  rootPathFromLocation,
  type WorkspaceConnectionChangedEvent,
  type WorkspaceLocation,
  WorkspaceLocationSchema,
  type WorkspaceMeta,
  type WorkspaceTask,
  workspaceLocationKey,
} from "../../../shared/types/workspace";
import type { WorkspaceColor } from "../../../shared/types/workspace-color";
import type { AgentChannel } from "../../infra/agent/channel";
import {
  type CreateLocalChannelOptions,
  createLocalChannel,
} from "../../infra/agent/channel/local-channel";
import {
  getAgentBinaryPath,
  getAgentBinDir,
  getAgentDistDir,
} from "../../infra/agent/getAgentBinDir";
import {
  type LocalAgentCommand,
  resolveLocalAgentCommand,
} from "../../infra/agent/local-agent-resolver";
import {
  removeShimDir as defaultRemoveShimDir,
  writeShimFiles as defaultWriteShimFiles,
  shimDir,
  worktreesDir,
} from "../../infra/agent/runtimeDirs";
import {
  type CreateSshChannelOptions,
  createSshChannel,
  type SshChannel,
} from "../../infra/agent/ssh/channel";
import type { SshForwarding } from "../../infra/agent/ssh/forward";
import type { SshControlMaster } from "../../infra/agent/ssh/master";
import type { RemoteAgentPlatform } from "../../infra/agent/ssh/ssh-bootstrap/index";
import {
  ensureRemoteLspServer as defaultEnsureRemoteLspServer,
  type EnsureRemoteAgentOptions,
  type EnsureRemoteAgentResult,
  type EnsureRemoteLspServerOptions,
  type EnsureRemoteLspServerResult,
  ensureRemoteAgent,
  type LspBootstrapProgressEvent,
  REMOTE_AGENT_ROOT,
  type SshBootstrapDependencies,
} from "../../infra/agent/ssh/ssh-bootstrap/index";
import { absoluteRemotePath } from "../../infra/agent/ssh/ssh-bootstrap/manifest";
import { isWindows, loginShell } from "../../infra/platform";
import type { GlobalStorage } from "../../infra/storage/global-storage";
import type { StateService } from "../../infra/storage/state-service";
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";
import { windowsCliLauncherDir } from "../cli/launchers";
import type { FsProvider } from "../fs/bridge/provider";
import { agentAliasPath } from "../git/domain/helpers/launcher";
import { type HookInfo, WorkspaceHooks } from "./connection/hooks";
import { LocalWorkspaceConnections } from "./connection/local";
import { RemoteWorkspaceConnections } from "./connection/remote";
import {
  createInitialFsProvider,
  createWorkspaceRemovedError,
  WorkspaceConnectionState,
} from "./connection/state";
import { defaultWslTransport, type WorkspaceWslTransport } from "./connection/wsl";
import { WorkspaceContext } from "./context";

export type { HookInfo } from "./connection/hooks";
export type { WorkspaceWslTransport } from "./connection/wsl";

const log = createLogger("workspace");

export type BroadcastFn = (channelName: string, event: string, args: unknown) => void;
export type WorkspaceCreateOptions =
  | { location: WorkspaceLocation; name?: string; color?: WorkspaceColor; task?: WorkspaceTask }
  | { rootPath: string; name?: string; color?: WorkspaceColor; task?: WorkspaceTask };
export type WorkspaceSshChannelFactory = (options: CreateSshChannelOptions) => SshChannel;
export type WorkspaceSshBootstrap = (
  options: EnsureRemoteAgentOptions,
  dependencies?: Pick<SshBootstrapDependencies, "onProgress">,
) => Promise<EnsureRemoteAgentResult>;
export type WorkspaceSshLspBootstrap = (
  options: EnsureRemoteLspServerOptions,
  dependencies?: Pick<SshBootstrapDependencies, "onProgress">,
) => Promise<EnsureRemoteLspServerResult>;
export type WorkspaceLocalChannelFactory = (options: CreateLocalChannelOptions) => AgentChannel;
export type WorkspaceLocalAgentCommandResolver = () => LocalAgentCommand;
export type WriteShimFilesFn = (workspaceId: string) => Promise<{
  dir: string;
  zshrc: string;
  zshenv: string;
  bashrc: string;
}>;
export type RemoveShimDirFn = (workspaceId: string) => Promise<void>;

function localLocation(rootPath: string): WorkspaceLocation {
  return { kind: "local", rootPath };
}

function normalizeCreateLocation(opts: WorkspaceCreateOptions): WorkspaceLocation {
  return WorkspaceLocationSchema.parse(
    "location" in opts ? opts.location : localLocation(opts.rootPath),
  );
}

function defaultWorkspaceName(location: WorkspaceLocation): string {
  if (location.kind === "ssh") {
    const folder = path.posix.basename(location.remotePath ?? "");
    if (folder && folder !== "~") return folder;
    return location.configAlias || location.host;
  }
  if (location.kind === "wsl") {
    return path.posix.basename(location.remotePath) || location.distro;
  }
  return path.basename(location.rootPath);
}

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

export class WorkspaceManager {
  private readonly globalStorage: GlobalStorage;
  private readonly workspaceStorage: WorkspaceStorage;
  private readonly stateService: StateService;
  private readonly broadcastFn: BroadcastFn;
  private readonly sshBootstrap: WorkspaceSshBootstrap;
  private readonly sshLspBootstrap: WorkspaceSshLspBootstrap;
  private readonly wsl: WorkspaceWslTransport;

  private ptySessionCloser: ((workspaceId: string) => void) | null = null;
  private chatSessionCloser:
    | ((workspaceId: string, channel: AgentChannel | null) => Promise<void>)
    | null = null;
  private readonly workspaceRemovals = new Map<string, Promise<void>>();

  private browserCloser: ((workspaceId: string) => Promise<void>) | null = null;

  private readonly contexts = new Map<string, WorkspaceContext>();
  private readonly connections: WorkspaceConnectionState;
  private readonly hooks = new WorkspaceHooks();
  private readonly local: LocalWorkspaceConnections;
  private readonly remote: RemoteWorkspaceConnections;
  private activeId: string | null = null;
  private selectionVersion = 0;

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
    writeShimFiles: WriteShimFilesFn = defaultWriteShimFiles,
    removeShimDir: RemoveShimDirFn = defaultRemoveShimDir,
    wsl: WorkspaceWslTransport = defaultWslTransport,
  ) {
    this.globalStorage = globalStorage;
    this.workspaceStorage = workspaceStorage;
    this.stateService = stateService;
    this.broadcastFn = broadcastFn;
    this.sshBootstrap = sshBootstrap;
    this.sshLspBootstrap = sshLspBootstrap;
    this.wsl = wsl;
    this.connections = new WorkspaceConnectionState(
      this.contexts,
      broadcastFn,
      writeShimFiles,
      removeShimDir,
    );
    this.local = new LocalWorkspaceConnections(
      this.connections,
      this.hooks,
      localChannelFactory,
      localAgentCommandResolver,
    );
    this.remote = new RemoteWorkspaceConnections(
      this.connections,
      this.hooks,
      globalStorage,
      sshChannelFactory,
      sshBootstrap,
      wsl,
    );
  }

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
    if (shouldAutoConnect(ctx.getMeta())) {
      void this.ensureProviderReady(ctx).catch((error) => {
        log.error(`initial provider bootstrap failed: ${(error as Error).message}`);
      });
    }
  }

  close(): void {
    for (const [id, ctx] of this.contexts) {
      this.remote.cancelPending(id);
      ctx.close();
      this.contexts.delete(id);
      this.connections.connectionStatuses.delete(id);
    }
    this.local.close();
    this.remote.close();
    this.globalStorage.close();
  }

  list(): WorkspaceMeta[] {
    return Array.from(this.contexts.values()).map((ctx) => ctx.getMeta());
  }

  findByLocation(location: WorkspaceLocation): WorkspaceMeta | null {
    const key = workspaceLocationKey(location);
    for (const ctx of this.contexts.values()) {
      if (workspaceLocationKey(ctx.getMeta().location) === key) {
        return ctx.getMeta();
      }
    }
    return null;
  }

  connectionSnapshot(): WorkspaceConnectionChangedEvent[] {
    return this.connections.connectionSnapshot();
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  async getFs(id: string): Promise<FsProvider> {
    const ctx = this.requireContext(id);
    await this.ensureProviderReady(ctx);
    return ctx.fs;
  }

  async getAgentChannel(id: string): Promise<AgentChannel> {
    if (this.workspaceRemovals.has(id)) throw createWorkspaceRemovedError(id);
    const ctx = this.requireContext(id);
    await this.ensureProviderReady(ctx);
    if (this.workspaceRemovals.has(id) || !this.connections.isLiveContext(id, ctx))
      throw createWorkspaceRemovedError(id);
    const channel = this.local.localChannels.get(id) ?? this.remote.sshChannels.get(id);
    if (!channel) {
      throw new Error(`agent channel not available for workspace: ${id}`);
    }
    return channel;
  }

  getName(id: string): string | null {
    return this.contexts.get(id)?.getMeta().name ?? null;
  }

  isLocal(id: string): boolean {
    return this.contexts.get(id)?.getMeta().location.kind === "local";
  }

  attachHost(id: string): string | null {
    const meta = this.contexts.get(id)?.getMeta();
    return meta ? attachHostOf(meta.location) : null;
  }

  requireContext(id: string): WorkspaceContext {
    const ctx = this.contexts.get(id);
    if (!ctx) {
      throw new Error(`workspace not found: ${id}`);
    }
    return ctx;
  }

  getHookInfo(workspaceId: string): HookInfo | null {
    return this.hooks.getHookInfo(workspaceId);
  }

  getSpawnHookInfo(workspaceId: string, channel: AgentChannel): Promise<HookInfo | null> {
    return this.local.getSpawnHookInfo(
      workspaceId,
      channel,
      () => this.local.localChannels.get(workspaceId) ?? this.remote.sshChannels.get(workspaceId),
    );
  }

  getWrapperBinDir(workspaceId: string): string | null {
    const ctx = this.contexts.get(workspaceId);
    if (!ctx) return null;
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      if (isWindows()) return windowsCliLauncherDir();
      return getAgentBinDir();
    }
    const bootstrap = this.remote.sshBootstraps.get(workspaceId);
    if (!bootstrap) return null;
    return bootstrap.remoteBinDir;
  }

  getWrapperAgentBin(workspaceId: string): string | null {
    const ctx = this.contexts.get(workspaceId);
    if (!ctx) return null;
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      const localAppData = process.env.LOCALAPPDATA;
      const alias =
        process.windowsStore && localAppData
          ? agentAliasPath(process.execPath, localAppData)
          : null;
      return alias ?? getAgentBinaryPath() ?? null;
    }
    const bootstrap = this.remote.sshBootstraps.get(workspaceId);
    if (!bootstrap) return null;
    const { remoteBinDir, platform } = bootstrap;
    const binaryName = resolveRemoteAgentBinaryName(platform);
    if (!binaryName) return null;
    return `${remoteBinDir}/${binaryName}`;
  }

  getWrapperShimDir(workspaceId: string): string | null {
    const ctx = this.contexts.get(workspaceId);
    if (!ctx) return null;
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      return shimDir(workspaceId);
    }
    const bootstrap = this.remote.sshBootstraps.get(workspaceId);
    if (!bootstrap) return null;
    return bootstrap.remoteShimDir ?? null;
  }

  getWrapperShell(workspaceId: string): string | null {
    const ctx = this.contexts.get(workspaceId);
    if (!ctx) return null;
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      if (isWindows()) return null;
      return loginShell();
    }
    const bootstrap = this.remote.sshBootstraps.get(workspaceId);
    if (!bootstrap) return null;
    return bootstrap.remoteShell ?? null;
  }

  getWorktreesRoot(workspaceId: string): string | null {
    const meta = this.contexts.get(workspaceId)?.getMeta();
    if (!meta) return null;
    if (meta.location.kind === "local") return worktreesDir();
    const bootstrap = this.remote.sshBootstraps.get(workspaceId);
    if (!bootstrap) return null;
    return absoluteRemotePath(bootstrap.remoteHome, `${REMOTE_AGENT_ROOT}/worktrees`);
  }

  async tryGetAgentChannel(id: string): Promise<AgentChannel | null> {
    if (!this.contexts.has(id) || this.workspaceRemovals.has(id)) return null;
    return this.getAgentChannel(id);
  }

  async peekAgentChannel(id: string): Promise<AgentChannel | null> {
    const ctx = this.contexts.get(id);
    if (!ctx) return null;
    if (ctx.getMeta().location.kind === "local") return this.getAgentChannel(id);
    const status = this.connections.connectionStatuses.get(id);
    if (status !== "connected" && status !== "unstable") return null;
    return this.remote.sshChannels.get(id) ?? null;
  }

  getSshForwarding(id: string): SshForwarding | null {
    const location = this.contexts.get(id)?.getMeta().location;
    if (location?.kind !== "ssh") return null;
    const status = this.connections.connectionStatuses.get(id);
    const bootstrap = this.remote.sshBootstraps.get(id);
    const connected = status === "connected" || status === "unstable";
    const { host, user, port, identityFile } = location;
    return {
      host,
      connecting: status === "connecting" || status === "reconnecting",
      target:
        connected && bootstrap
          ? { host, user, port, identityFile, controlPath: bootstrap.controlPath }
          : null,
    };
  }

  setPtySessionCloser(closer: (workspaceId: string) => void): void {
    this.ptySessionCloser = closer;
  }

  setPtyHeldCallbacks(
    restoreAfterReauth: (workspaceId: string) => Promise<void>,
    releaseHeld: (workspaceId: string) => void,
  ): void {
    this.remote.ptyRestoreAfterReauth = restoreAfterReauth;
    this.remote.ptyReleaseHeld = releaseHeld;
  }

  setBrowserCloser(closer: (workspaceId: string) => Promise<void>): void {
    this.browserCloser = closer;
  }

  onProviderReady(listener: (workspaceId: string, provider: FsProvider) => void): () => void {
    return this.connections.onProviderReady(listener);
  }

  async createAndConnectSsh(opts: WorkspaceCreateOptions): Promise<WorkspaceMeta> {
    const location = normalizeCreateLocation(opts);
    if (location.kind !== "ssh") {
      throw new Error("createAndConnectSsh called for non-SSH location");
    }

    const existing = this.findByLocation(location);
    if (existing) {
      return this.touchLastOpened(existing.id);
    }

    const bootstrap = await this.sshBootstrap({
      host: location.host,
      user: location.user,
      port: location.port,
      identityFile: location.identityFile,
      authMode: location.authMode,
      remotePath: location.remotePath,
    });

    let meta: WorkspaceMeta;
    try {
      meta = this.create(opts);
    } catch (error) {
      bootstrap.dispose?.();
      throw error;
    }

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
      bootstrap.dispose?.();
    }

    return meta;
  }

  create(opts: WorkspaceCreateOptions): WorkspaceMeta {
    const location = normalizeCreateLocation(opts);
    const existing = this.findByLocation(location);
    if (existing) {
      return this.touchLastOpened(existing.id);
    }

    const id = randomUUID();
    const rootPath = rootPathFromLocation(location);
    const name = opts.name ?? defaultWorkspaceName(location);
    const sortOrder = opts.task ? 0 : this.globalStorage.nextTailSortOrder("unpinned");
    const meta: WorkspaceMeta = {
      id,
      name,
      location,
      rootPath,
      color: opts.color ?? "auto",
      pinned: false,
      lastOpenedAt: new Date().toISOString(),
      tabs: [],
      sortOrder,
      pinnedSortOrder: 0,
      ...(opts.task ? { task: opts.task } : {}),
    };

    this.globalStorage.addWorkspace(meta);
    this.workspaceStorage.openForWorkspace(id);
    const ctx = new WorkspaceContext(meta, this.workspaceStorage, createInitialFsProvider(meta));
    ctx.setMeta(meta);
    this.contexts.set(id, ctx);

    this.broadcastFn("workspace", "changed", meta);
    return meta;
  }

  adoptSshControlMaster(workspaceId: string, master: SshControlMaster): void {
    this.remote.adoptSshControlMaster(workspaceId, master);
  }

  update(id: string, partial: Partial<Omit<WorkspaceMeta, "id" | "tabs">>): WorkspaceMeta {
    const ctx = this.contexts.get(id);
    if (!ctx) {
      throw new Error(`workspace not found: ${id}`);
    }
    const current = ctx.getMeta();
    const normalizedPartial = normalizeWorkspaceUpdate(partial);

    const pinnedChanged =
      normalizedPartial.pinned !== undefined && normalizedPartial.pinned !== current.pinned;

    if (pinnedChanged) {
      const newPinned = normalizedPartial.pinned as boolean;
      const targetGroup: "pinned" | "unpinned" = newPinned ? "pinned" : "unpinned";
      const tailPos = this.globalStorage.nextTailSortOrder(targetGroup);
      const newSortOrder = newPinned ? 0 : tailPos;
      const newPinnedSortOrder = newPinned ? tailPos : 0;

      this.globalStorage.updateSortOrder(id, {
        sortOrder: newSortOrder,
        pinnedSortOrder: newPinnedSortOrder,
        pinned: newPinned,
      });
      const { pinned: _pinned, ...restPartial } = normalizedPartial;
      if (Object.keys(restPartial).length > 0) {
        this.globalStorage.updateWorkspace(id, restPartial);
      }
      const updated: WorkspaceMeta = {
        ...current,
        ...normalizedPartial,
        sortOrder: newSortOrder,
        pinnedSortOrder: newPinnedSortOrder,
      };
      ctx.setMeta(updated);
      this.broadcastFn("workspace", "changed", updated);
      return updated;
    }

    this.globalStorage.updateWorkspace(id, normalizedPartial);
    const updated: WorkspaceMeta = { ...current, ...normalizedPartial };
    ctx.setMeta(updated);

    this.broadcastFn("workspace", "changed", updated);
    return updated;
  }

  reorder(
    id: string,
    opts: {
      beforeId?: string;
      afterId?: string;
      targetGroup: "pinned" | "unpinned";
    },
  ): WorkspaceMeta {
    const ctx = this.contexts.get(id);
    if (!ctx) {
      throw new Error(`workspace not found: ${id}`);
    }

    const current = ctx.getMeta();
    const result = this.globalStorage.reorderWorkspace(id, {
      currentPinned: current.pinned,
      ...opts,
    });

    const finalMeta: WorkspaceMeta = {
      ...current,
      pinned: opts.targetGroup === "pinned",
      sortOrder: result.sortOrder,
      pinnedSortOrder: result.pinnedSortOrder,
    };

    ctx.setMeta(finalMeta);
    for (const row of result.rebalancedRows ?? []) {
      const other = row.id === id ? undefined : this.contexts.get(row.id);
      if (other) {
        other.setMeta({
          ...other.getMeta(),
          sortOrder: row.sortOrder,
          pinnedSortOrder: row.pinnedSortOrder,
        });
      }
    }

    if (result.rebalancedRows) {
      const orders = new Map(
        result.rebalancedRows.map((row) => [row.id, { ...row, pinned: finalMeta.pinned }]),
      );
      orders.set(id, {
        id,
        sortOrder: finalMeta.sortOrder,
        pinnedSortOrder: finalMeta.pinnedSortOrder,
        pinned: finalMeta.pinned,
      });
      this.broadcastFn("workspace", "reordered", { orders: [...orders.values()] });
    } else {
      this.broadcastFn("workspace", "changed", finalMeta);
    }

    return finalMeta;
  }

  private touchLastOpened(id: string): WorkspaceMeta {
    return this.update(id, { lastOpenedAt: new Date().toISOString() });
  }

  setChatSessionCloser(
    closer: (workspaceId: string, channel: AgentChannel | null) => Promise<void>,
  ): void {
    this.chatSessionCloser = closer;
  }

  remove(id: string): Promise<void> {
    const pending = this.workspaceRemovals.get(id);
    if (pending) return pending;
    const ctx = this.contexts.get(id);
    if (!ctx) return Promise.resolve();
    const removal = this.removeWorkspace(id, ctx).finally(() => this.workspaceRemovals.delete(id));
    this.workspaceRemovals.set(id, removal);
    return removal;
  }

  private async removeWorkspace(id: string, ctx: WorkspaceContext): Promise<void> {
    const taskRemovals = this.list()
      .filter((task) => task.task?.parentId === id)
      .map((task) => this.remove(task.id));

    this.ptySessionCloser?.(id);
    this.remote.cancelPending(id);
    if (this.chatSessionCloser) {
      const status = this.connections.connectionStatuses.get(id);
      const channel =
        this.local.localChannels.get(id) ??
        (status === "connected" || status === "unstable"
          ? this.remote.sshChannels.get(id)
          : undefined);
      const closingChats = this.chatSessionCloser(id, channel ?? null).catch((error: unknown) => {
        log.warn(`chat cleanup failed for removed workspace ${id}: ${String(error)}`);
      });
      await Promise.all([...taskRemovals, closingChats]);
    }

    if (this.browserCloser) {
      void this.browserCloser(id).catch((err: unknown) => {
        log.warn(`browser closer failed for ${id}: ${(err as Error).message}`);
      });
    }

    this.remote.stopRemovedAgent(id, ctx);

    ctx.close();
    this.contexts.delete(id);
    this.local.remove(id);
    this.remote.remove(id);
    this.hooks.clear(id);
    this.connections.removeShimDirQuietly(id);
    this.globalStorage.removeWorkspace(id);

    if (this.activeId === id) {
      const remaining = this.list().filter((workspace) => !workspace.task);
      this.activeId = remaining.length > 0 ? remaining[0].id : null;
      this.stateService.setState({ lastActiveWorkspaceId: this.activeId ?? undefined });
    }

    this.broadcastFn("workspace", "removed", { id });
    this.connections.connectionStatuses.delete(id);
  }

  async activate(id: string): Promise<void> {
    const ctx = this.requireContext(id);
    this.stateService.setState({ lastActiveWorkspaceId: id });
    this.activeId = id;
    const version = ++this.selectionVersion;

    await this.ensureProviderReady(ctx);
    if (version === this.selectionVersion && this.contexts.get(id) === ctx) {
      this.touchLastOpened(id);
    }
  }

  async connect(id: string): Promise<void> {
    await this.ensureProviderReady(this.requireContext(id));
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
    if (meta.location.kind === "local") {
      return null;
    }

    await this.ensureProviderReady(ctx);
    const refreshedMeta = ctx.getMeta();
    if (refreshedMeta.location.kind === "local") {
      return null;
    }

    if (refreshedMeta.location.kind === "wsl") {
      const result = await this.wsl.lspBootstrap(
        {
          distro: refreshedMeta.location.distro,
          remotePath: refreshedMeta.location.remotePath,
          cachedRemoteArch: refreshedMeta.location.remoteArch,
          binaryName: request.binaryName,
          languageId: request.languageId,
        },
        { onProgress },
      );
      return { binaryPath: result.binaryPath, args: result.args };
    }

    const bootstrap = this.remote.sshBootstraps.get(workspaceId);
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

  private async ensureProviderReady(ctx: WorkspaceContext): Promise<void> {
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      await this.local.ensureLocalProviderReady(ctx);
      return;
    }
    await this.remote.ensureRemoteProviderReady(ctx);
  }
}

function shouldAutoConnect(meta: WorkspaceMeta): boolean {
  if (meta.location.kind !== "ssh") return true;
  return meta.location.authMode === "key-only";
}

function resolveRemoteAgentBinaryName(platform: RemoteAgentPlatform): string | null {
  const distDir = getAgentDistDir();
  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = AgentManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    return `agent-${manifest.version}-${platform.os}-${platform.arch}`;
  } catch {
    return null;
  }
}
