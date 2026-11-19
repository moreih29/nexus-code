import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentManifestSchema } from "../../../shared/agent/manifest";
import { createLogger } from "../../../shared/log/main";
import {
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

// ---------------------------------------------------------------------------
// Broadcast callback type — injected so the manager has no hard import on
// Electron and can be tested without a live renderer process.
// ---------------------------------------------------------------------------

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
 *
 * For SSH, uses the last folder name of remotePath. The sidebar's primary
 * line should read as the "project folder" rather than the host, so the workspace is easy
 * to identify — the user@host info is shown separately on the sidebar's sub-line.
 * Alias/host is used only in the fallback case where remotePath is root ("/") or empty.
 */
function defaultWorkspaceName(location: WorkspaceLocation): string {
  if (location.kind === "ssh") {
    // remotePath is always POSIX — use path.posix.basename.
    const folder = path.posix.basename(location.remotePath ?? "");
    if (folder && folder !== "~") return folder;
    return location.configAlias || location.host;
  }
  if (location.kind === "wsl") {
    return path.posix.basename(location.remotePath) || location.distro;
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
  private readonly sshBootstrap: WorkspaceSshBootstrap;
  private readonly sshLspBootstrap: WorkspaceSshLspBootstrap;
  private readonly wsl: WorkspaceWslTransport;

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
  /** Closes chats on the already-open channel before removal closes it. */
  private chatSessionCloser:
    | ((workspaceId: string, channel: AgentChannel | null) => Promise<void>)
    | null = null;
  private readonly workspaceRemovals = new Map<string, Promise<void>>();

  /**
   * Optional async callback invoked by `remove()` after the PTY sessions are
   * closed and before the workspace:removed broadcast. Injected after
   * construction (see `setBrowserCloser`) so the browser registry and
   * WorkspaceManager can be wired without a circular import.
   * When set, remove() awaits this to destroy all browser views and clear the
   * workspace's storage partition before the context is deleted.
   */
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
    //
    // Interactive (password) SSH workspaces skip auto-connect: they restore
    // in the idle/disconnected state and only connect on explicit user action.
    if (shouldAutoConnect(ctx.getMeta())) {
      void this.ensureProviderReady(ctx).catch((error) => {
        log.error(`initial provider bootstrap failed: ${(error as Error).message}`);
      });
    }
  }

  /**
   * Close all open workspace storage handles and the global storage.
   * Call from app.on('will-quit').
   */
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

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(): WorkspaceMeta[] {
    return Array.from(this.contexts.values()).map((ctx) => ctx.getMeta());
  }

  /**
   * Finds an already-registered workspace whose location refers to the same
   * target (canonical key match), or null when none matches. Used to dedupe
   * "open workspace" requests so the same folder/host never produces two
   * separate entries.
   */
  findByLocation(location: WorkspaceLocation): WorkspaceMeta | null {
    const key = workspaceLocationKey(location);
    for (const ctx of this.contexts.values()) {
      if (workspaceLocationKey(ctx.getMeta().location) === key) {
        return ctx.getMeta();
      }
    }
    return null;
  }

  /** Current remote connection statuses for a newly opened renderer. */
  connectionSnapshot(): WorkspaceConnectionChangedEvent[] {
    return this.connections.connectionSnapshot();
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

  /**
   * Returns the display name of the workspace, or `null` when no workspace
   * with the given id is registered. Safe for use in fire-and-forget paths
   * where a missing workspace is an expected race condition.
   */
  getName(id: string): string | null {
    return this.contexts.get(id)?.getMeta().name ?? null;
  }

  /** Whether the workspace runs on this machine rather than over SSH. */
  isLocal(id: string): boolean {
    return this.contexts.get(id)?.getMeta().location.kind === "local";
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
   * Returns the hookserver connection info that was fetched by pull and stored in memory.
   * Returns null before ensureProviderReady completes or when the RPC failed.
   */
  getHookInfo(workspaceId: string): HookInfo | null {
    return this.hooks.getHookInfo(workspaceId);
  }

  /** Returns the hooks for the channel about to start a chat or terminal. */
  getSpawnHookInfo(workspaceId: string, channel: AgentChannel): Promise<HookInfo | null> {
    return this.local.getSpawnHookInfo(
      workspaceId,
      channel,
      () => this.local.localChannels.get(workspaceId) ?? this.remote.sshChannels.get(workspaceId),
    );
  }

  /**
   * Returns the absolute path of the bin directory that holds the wrapper binaries, by workspace kind.
   *
   * - Local workspace: the local deployment bin directory (`getAgentBinDir()`).
   *   On Windows, the directory of the nexus launchers alone: PowerShell
   *   and cmd cannot run the bash claude wrapper. Git Bash, which can, gets
   *   the wrapper's copy instead (pty/windows-shell-shim.ts).
   * - SSH workspace:  `remoteBinDir` from the bootstrap result (absolute path)
   * - No workspace / no channel: null
   */
  getWrapperBinDir(workspaceId: string): string | null {
    const ctx = this.contexts.get(workspaceId);
    if (!ctx) return null;
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      // A Windows shell cannot run the bash wrapper, and with its directory
      // first on PATH, `claude` could resolve to it instead of the real one.
      if (isWindows()) return windowsCliLauncherDir();
      return getAgentBinDir();
    }
    const bootstrap = this.remote.sshBootstraps.get(workspaceId);
    if (!bootstrap) return null;
    return bootstrap.remoteBinDir;
  }

  /**
   * Returns the absolute path of the agent binary, by workspace kind.
   *
   * - Local workspace: the local deployment agent binary path (`getAgentBinaryPath()`).
   *   From the Microsoft Store, the package's alias for the agent: claude
   *   runs the hooks outside the package, and only the alias may start it.
   * - SSH workspace:  `${remoteBinDir}/agent-<version>-<os>-<arch>` (assembled from the bootstrap result)
   * - No workspace / no bootstrap: null
   */
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

  /**
   * Returns the absolute path of the workspace's PTY shell-shim directory (where the
   * `.zshrc`/`.zshenv`/`bashrc` shim files live). The spawn handler in `ipc.ts` uses this value
   * as the ZDOTDIR (zsh) or `--rcfile` (bash) argument.
   *
   * - Local workspace: local `~/.nexus-code/shim/<workspaceId>` (= `shimDir()`).
   *   The shim files were already written by `writeShimFiles()` when the workspace booted.
   * - SSH workspace:  the absolute path `<remoteHome>/.nexus-code/shim/shared` that
   *   bootstrap uploaded to the remote (`bootstrap.remoteShimDir`). Null when the bootstrap
   *   result lacks it (a missing workspaceId or a failed upload); applying the shim must be skipped.
   * - No workspace: null
   */
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

  /**
   * The login shell of the workspace's terminals, which decides whether the
   * shell shim (ZDOTDIR or --rcfile) applies.
   *
   * - Local: `loginShell()`, the shell the agent starts terminals with too
   *   (main sets $SHELL to it at startup). Null on Windows, whose shells
   *   take no zsh or bash shim.
   * - SSH: the remote `$SHELL` the bootstrap read. Null when it is unknown:
   *   guessing bash would hand a fish or csh user `--rcfile`.
   * - No workspace or no bootstrap: null.
   *
   * Null skips the shim. The wrapper bin is still first on PATH at spawn,
   * but without the precmd hook a user rc that reorders PATH can push it
   * back.
   */
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

  /**
   * Returns the ready workspace-scoped agent channel, or `null` when the
   * workspace is not found. Unlike `getAgentChannel`, this method never
   * throws for a missing workspace — callers where "workspace removed before
   * IPC arrived" is an expected racing condition should use this form.
   */
  /**
   * The folder that holds the worktrees of this workspace's tasks, on the
   * host the workspace lives on: ~/.nexus-code/worktrees locally, the same
   * under the remote home for SSH. Null for an SSH workspace that has not
   * connected yet.
   */
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

  /**
   * The workspace's agent channel only while it is up: null for an SSH or
   * WSL workspace that is not connected, which this never connects, so a
   * background poll cannot dial a host the user left disconnected. A local
   * workspace's agent is started as getAgentChannel does.
   */
  async peekAgentChannel(id: string): Promise<AgentChannel | null> {
    const ctx = this.contexts.get(id);
    if (!ctx) return null;
    if (ctx.getMeta().location.kind === "local") return this.getAgentChannel(id);
    const status = this.connections.connectionStatuses.get(id);
    if (status !== "connected" && status !== "unstable") return null;
    return this.remote.sshChannels.get(id) ?? null;
  }

  /**
   * An SSH workspace's host and, while it is connected, the connection its
   * ports are forwarded over: its ControlMaster, or none for key-only auth.
   * Null for a workspace that is not on an SSH host.
   */
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

  /**
   * Registers the PTY session closer called by `remove()` before the
   * workspace context is deleted. Wired from `main/index.ts` after both the
   * WorkspaceManager and the PTY host have been constructed — breaks the
   * circular dependency without restructuring constructors.
   */
  setPtySessionCloser(closer: (workspaceId: string) => void): void {
    this.ptySessionCloser = closer;
  }

  /**
   * Registers the PTY reauth-restore and release-held callbacks. Wired from
   * `main/index.ts` after both the WorkspaceManager and the PTY host have been
   * constructed — breaks the circular dependency without restructuring
   * constructors.
   */
  setPtyHeldCallbacks(
    restoreAfterReauth: (workspaceId: string) => Promise<void>,
    releaseHeld: (workspaceId: string) => void,
  ): void {
    this.remote.ptyRestoreAfterReauth = restoreAfterReauth;
    this.remote.ptyReleaseHeld = releaseHeld;
  }

  /**
   * Registers the browser closer called by `remove()` before the workspace
   * context is deleted. Wired from `main/index.ts` after both the
   * WorkspaceManager and the browser registry have been initialised — breaks
   * the construction-time circular dependency without restructuring constructors.
   *
   * The closer destroys all WebContentsViews for the workspace and clears the
   * workspace's storage partition via session.fromPartition().clearStorageData().
   */
  setBrowserCloser(closer: (workspaceId: string) => Promise<void>): void {
    this.browserCloser = closer;
  }

  /**
   * Subscribes to agent boots: fires each time a workspace gets a newly
   * started agent provider, on first activation and again when the previous
   * channel died and a later call booted a replacement. The new agent knows
   * nothing the old one had registered (fs and .git watches), and listeners
   * attached to the old provider never hear from it.
   */
  onProviderReady(listener: (workspaceId: string, provider: FsProvider) => void): () => void {
    return this.connections.onProviderReady(listener);
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

    // Dedupe before authenticating: an open request for an already-registered
    // SSH target focuses the existing workspace and skips a redundant
    // connection round entirely.
    const existing = this.findByLocation(location);
    if (existing) {
      return this.touchLastOpened(existing.id);
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
    const location = normalizeCreateLocation(opts);
    // Dedupe: an open request for an already-registered location focuses the
    // existing workspace instead of creating a second entry for the same target.
    const existing = this.findByLocation(location);
    if (existing) {
      return this.touchLastOpened(existing.id);
    }

    const id = randomUUID();
    const rootPath = rootPathFromLocation(location);
    const name = opts.name ?? defaultWorkspaceName(location);
    // New workspaces are always placed at the tail of the unpinned group so
    // they appear below existing items without perturbing existing positions.
    // A task is not a sidebar row and keeps position 0.
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

  /**
   * Adopts a ControlMaster handed off from an SSH directory-browse session.
   * The next SSH provider boot for this workspace reuses that socket, so the
   * user is not prompted for credentials a second time. Safe to call before
   * the provider boots; the master is consumed by startRemoteProvider.
   */
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

    // Pin toggle: when the pinned flag changes, move the workspace to the tail
    // of its new group and zero the sort column for the group it leaves.
    // This keeps drag-and-drop positions stable for the retained group.
    const pinnedChanged =
      normalizedPartial.pinned !== undefined && normalizedPartial.pinned !== current.pinned;

    if (pinnedChanged) {
      const newPinned = normalizedPartial.pinned as boolean;
      const targetGroup: "pinned" | "unpinned" = newPinned ? "pinned" : "unpinned";
      const tailPos = this.globalStorage.nextTailSortOrder(targetGroup);
      // Moving to pinned group: pinned_sort_order = tail, sort_order = 0.
      // Moving to unpinned group: sort_order = tail, pinned_sort_order = 0.
      const newSortOrder = newPinned ? 0 : tailPos;
      const newPinnedSortOrder = newPinned ? tailPos : 0;

      // Write sort columns + pinned flag together, then update other fields.
      this.globalStorage.updateSortOrder(id, {
        sortOrder: newSortOrder,
        pinnedSortOrder: newPinnedSortOrder,
        pinned: newPinned,
      });
      // Strip pinned from the general updateWorkspace call to avoid double-write.
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

  /**
   * Moves a workspace to a new position within the sidebar list.
   *
   * `targetGroup` specifies which group the item lands in; when it differs from
   * the item's current group the `pinned` flag is automatically flipped and the
   * source group's sort column is zeroed.
   *
   * Position anchoring (mutually exclusive, natural-language semantics):
   *   - Neither `beforeId` nor `afterId` → tail of `targetGroup`.
   *   - `beforeId` only → the new row goes IMMEDIATELY BEFORE that item
   *     (midpoint with its predecessor; or `beforeId.pos − 1024` when first).
   *   - `afterId` only → the new row goes IMMEDIATELY AFTER that item
   *     (midpoint with its successor; or `afterId.pos + 1024` when last).
   *
   * When the gap between neighbours collapses to < 2 the group is rebalanced
   * first and the new position is recomputed.  In that case `workspace.reordered`
   * is broadcast carrying every affected row so the renderer can refresh the whole
   * list in one pass; otherwise the lighter `workspace.changed` event is used.
   *
   * The entire read-compute-write sequence runs inside a single SQLite transaction.
   */
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

    // Update in-memory context after the storage transaction commits.
    ctx.setMeta(finalMeta);
    // A rebalance moved the group's other rows too: list() (nexus, other
    // devices) gives them in their new order, as the sidebar shows them.
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

    // Broadcast outside the transaction so IPC calls never run inside a DB lock.
    if (result.rebalancedRows) {
      // Merge the reordered workspace's new values into the rebalanced set so
      // every row in the group is accounted for in the bulk event.
      const merged = result.rebalancedRows.map((r) =>
        r.id === id
          ? { id: r.id, sortOrder: finalMeta.sortOrder, pinnedSortOrder: finalMeta.pinnedSortOrder }
          : r,
      );
      this.broadcastFn("workspace", "reordered", merged);
    } else {
      this.broadcastFn("workspace", "changed", finalMeta);
    }

    return finalMeta;
  }

  /**
   * Bumps lastOpenedAt to now so the workspace sorts to the top of the
   * recency-ordered list. Used when an "open" request resolves to an
   * already-registered workspace and on explicit user activation.
   */
  private touchLastOpened(id: string): WorkspaceMeta {
    return this.update(id, { lastOpenedAt: new Date().toISOString() });
  }

  /** Installs chat cleanup without coupling the workspace manager to the chat host. */
  setChatSessionCloser(
    closer: (workspaceId: string, channel: AgentChannel | null) => Promise<void>,
  ): void {
    this.chatSessionCloser = closer;
  }

  /** Removes the workspace and waits for its chats to close on its current agent. */
  remove(id: string): Promise<void> {
    const pending = this.workspaceRemovals.get(id);
    if (pending) return pending;
    const ctx = this.contexts.get(id);
    if (!ctx) return Promise.resolve();
    const removal = this.removeWorkspace(id, ctx).finally(() => this.workspaceRemovals.delete(id));
    this.workspaceRemovals.set(id, removal);
    return removal;
  }

  /** Tears down the removed workspace's sessions before releasing its resources. */
  private async removeWorkspace(id: string, ctx: WorkspaceContext): Promise<void> {
    // A workspace's tasks go with it. Their worktrees stay on disk; git
    // forgets one once its folder is deleted (`git worktree prune`).
    const taskRemovals = this.list()
      .filter((task) => task.task?.parentId === id)
      .map((task) => this.remove(task.id));

    // Step 1 — terminate all PTY sessions for this workspace *before* the
    // context is deleted. This prevents the renderer's post-removal pty.kill
    // IPC calls from reaching `requireContext` on a missing workspace and
    // producing spurious "Error occurred in handler for 'ipc:call'" logs.
    // The PTY host emits pty.exit events for each live session so the
    // renderer's dead-terminal banner fires without waiting for IPC.
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
      // Start the parent's close while child workspaces close their chats.
      await Promise.all([...taskRemovals, closingChats]);
    }

    // Step 1b — destroy all browser views for this workspace and schedule
    // clearStorageData. View destroys happen synchronously inside the async
    // closer before the first await, so they complete before the context is
    // deleted below. clearStorageData is fire-and-forget relative to remove().
    if (this.browserCloser) {
      void this.browserCloser(id).catch((err: unknown) => {
        log.warn(`browser closer failed for ${id}: ${(err as Error).message}`);
      });
    }

    this.remote.stopRemovedAgent(id, ctx);

    // Step 2 — dispose the workspace storage handle and agent channels.
    ctx.close();
    this.contexts.delete(id);
    this.local.remove(id);
    this.remote.remove(id);
    // The hookserver connection info is deleted together with the workspace.
    this.hooks.clear(id);
    this.connections.removeShimDirQuietly(id);
    this.globalStorage.removeWorkspace(id);

    if (this.activeId === id) {
      const remaining = this.list().filter((workspace) => !workspace.task);
      this.activeId = remaining.length > 0 ? remaining[0].id : null;
      this.stateService.setState({ lastActiveWorkspaceId: this.activeId ?? undefined });
    }

    // Step 3 — broadcast removal so the renderer and main-side subscribers
    // (gitRegistry, fsWatcher, …) clean up workspace-scoped state. By this
    // point PTY sessions are already gone so the renderer's cleanup handlers
    // arrive after the fact — idempotent, not a race.
    this.broadcastFn("workspace", "removed", { id });
    this.connections.connectionStatuses.delete(id);
  }

  /**
   * Record a user's selection before connecting. Readiness can finish in
   * any order, so only the latest selection can update recency afterward.
   */
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

  /** Bring a workspace online for its existing views without changing selection. */
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

  /**
   * Boots the workspace-scoped agent channel before exposing the workspace as active.
   */
  private async ensureProviderReady(ctx: WorkspaceContext): Promise<void> {
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      await this.local.ensureLocalProviderReady(ctx);
      return;
    }
    await this.remote.ensureRemoteProviderReady(ctx);
  }
}

/**
 * Returns true when a workspace should auto-connect at app startup.
 * Local and WSL workspaces always connect immediately. SSH workspaces only connect
 * automatically when the authMode is "key-only"; interactive (password) SSH
 * workspaces restore in the disconnected state and connect on explicit user
 * action (sidebar click / panel Connect button) to avoid an unsolicited
 * password prompt during startup.
 */
function shouldAutoConnect(meta: WorkspaceMeta): boolean {
  if (meta.location.kind !== "ssh") return true;
  return meta.location.authMode === "key-only";
}

/**
 * Derives the agent binary filename for the given remote platform by reading
 * the local manifest. The installed binary on the remote follows the same
 * naming convention: `agent-<version>-<os>-<arch>`.
 *
 * Returns null when the manifest cannot be read or parsed.
 */
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
