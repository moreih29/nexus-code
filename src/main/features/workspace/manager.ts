import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createAbortError } from "../../../shared/abort";
import { AgentManifestSchema } from "../../../shared/agent/manifest";
import { createLogger } from "../../../shared/log/main";
import {
  rootPathFromLocation,
  type WorkspaceConnectionEventStatus,
  type WorkspaceLocation,
  WorkspaceLocationSchema,
  type WorkspaceMeta,
  type WorkspaceTask,
  workspaceLocationKey,
} from "../../../shared/types/workspace";
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
  type SshChannelLifecycleEvent,
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
import { createWslChannel, ensureWslAgent, ensureWslLspServer } from "../../infra/agent/wsl";
import { isWindows, loginShell } from "../../infra/platform";
import type { GlobalStorage } from "../../infra/storage/global-storage";
import type { StateService } from "../../infra/storage/state-service";
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";
import { windowsCliLauncherDir } from "../cli/launchers";
import { AgentFsProvider } from "../fs/bridge/agent-provider";
import { createFsProvider } from "../fs/bridge/create-provider";
import type { FsProvider } from "../fs/bridge/provider";
import { agentAliasPath } from "../git/domain/helpers/launcher";
import { WorkspaceContext } from "./context";

const log = createLogger("workspace");

/** Delays before the three automatic SSH reauthentication attempts. */
const SSH_REAUTH_BACKOFF_MS = [0, 5_000, 30_000];

/**
 * How long a removed SSH workspace's agent has to answer agent.shutdown,
 * asked again included: one being reconnected to is asked once the link is
 * back, as long as the channel's reconnect queue keeps a call.
 */
const SSH_AGENT_SHUTDOWN_TIMEOUT_MS = 30_000;
/** The pause before agent.shutdown is asked again, after the link dropped under it. */
const SSH_AGENT_SHUTDOWN_RETRY_MS = 250;
/**
 * How long another agent on the host has to stop a removed workspace's
 * daemon; it dials that daemon and waits for its own agent.shutdown reply.
 */
const SSH_PEER_DAEMON_STOP_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Broadcast callback type — injected so the manager has no hard import on
// Electron and can be tested without a live renderer process.
// ---------------------------------------------------------------------------

export type BroadcastFn = (channelName: string, event: string, args: unknown) => void;
export type WorkspaceCreateOptions =
  | { location: WorkspaceLocation; name?: string; task?: WorkspaceTask }
  | { rootPath: string; name?: string; task?: WorkspaceTask };
type SshWorkspaceLocation = Extract<WorkspaceLocation, { kind: "ssh" }>;
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
/** How a WSL workspace's agent is installed, reached, and given language servers. */
export interface WorkspaceWslTransport {
  readonly bootstrap: typeof ensureWslAgent;
  readonly createChannel: typeof createWslChannel;
  readonly lspBootstrap: typeof ensureWslLspServer;
}
const defaultWslTransport: WorkspaceWslTransport = {
  bootstrap: ensureWslAgent,
  createChannel: createWslChannel,
  lspBootstrap: ensureWslLspServer,
};
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
// hook.getInfo response type — holds each workspace's hookserver connection info, obtained by pull.
// ---------------------------------------------------------------------------

/** hookserver connection info the agent returns from the hook.getInfo RPC. */
export interface HookInfo {
  readonly socketPath: string;
  readonly token: string;
  /** Whether the server takes tabs' own tokens (./tab-token.ts): an older agent does not. */
  readonly tabTokens?: boolean;
}

interface LocalHookRefresh {
  promise: Promise<void>;
  resolve: () => void;
}

/**
 * Type guard for the hook.getInfo response.
 * A response is valid only when both socketPath and token are strings.
 */
function isHookInfo(value: unknown): value is HookInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.socketPath === "string" && typeof v.token === "string";
}

/**
 * Asks a removed workspace's remote agent to exit, then closes its channel
 * and connection. Closing them alone leaves the daemon holding the
 * workspace's terminals and language servers until its reattach grace ends.
 * A channel that is reconnecting holds the request until the link is back;
 * one the link drops under (an unstable link's ssh giving up) is asked
 * again, all within SSH_AGENT_SHUTDOWN_TIMEOUT_MS: a call's own timeout
 * starts only once it leaves the reconnect queue. Resolves whether the
 * agent answered.
 */
async function stopSshAgent(
  channel: SshChannel,
  bootstrap: EnsureRemoteAgentResult | undefined,
): Promise<boolean> {
  const deadline = Date.now() + SSH_AGENT_SHUTDOWN_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), SSH_AGENT_SHUTDOWN_TIMEOUT_MS);
  });
  let stopped = false;
  try {
    for (;;) {
      try {
        const answer = await Promise.race([
          channel
            .call("agent.shutdown", undefined, { timeoutMs: Math.max(1, deadline - Date.now()) })
            .then(() => "answered" as const),
          expired,
        ]);
        if (answer === "expired") {
          log.warn("agent.shutdown got no answer in time");
          break;
        }
        stopped = true;
        break;
      } catch (error) {
        const retryable = (error as { retryable?: unknown }).retryable === true;
        if (!retryable || Date.now() + SSH_AGENT_SHUTDOWN_RETRY_MS >= deadline) {
          log.warn(`agent.shutdown failed: ${(error as Error).message}`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, SSH_AGENT_SHUTDOWN_RETRY_MS));
      }
    }
  } finally {
    clearTimeout(timer);
  }
  channel.dispose();
  bootstrap?.dispose?.();
  return stopped;
}

/**
 * Asks the remote agent on `channel` to stop the daemon of another
 * workspace on its host, at `root`: one removed while not connected, whose
 * daemon would otherwise hold its terminals until its reattach grace ends.
 */
async function stopPeerDaemon(channel: SshChannel, root: string): Promise<void> {
  await channel
    .call("agent.stopDaemon", { root }, { timeoutMs: SSH_PEER_DAEMON_STOP_TIMEOUT_MS })
    .catch((error: unknown) => {
      log.warn(`agent.stopDaemon failed: ${(error as Error).message}`);
    });
}

/** Whether two remote locations are on one host, as one user, where their daemons share a run folder. */
function sameRemoteHost(a: WorkspaceLocation, b: WorkspaceLocation): boolean {
  if (a.kind === "ssh" && b.kind === "ssh") {
    return a.host === b.host && a.user === b.user && (a.port ?? 22) === (b.port ?? 22);
  }
  return a.kind === "wsl" && b.kind === "wsl" && a.distro === b.distro;
}

/** Rejects a provider boot whose workspace was removed while it was in flight. */
function createWorkspaceRemovedError(id: string): Error {
  return createAbortError(`workspace ${id} was removed while its agent was starting`);
}

/**
 * Decides whether a `hook.getInfo` response carries the `server.unavailable` code.
 * It is a graceful-degrade signal that the agent failed to create the hookserver; the workspace
 * must keep booting and run with only the Claude hook feature disabled.
 * CodedError and errorFromServerFrame attach a `code` property to the
 * Error, so that value is checked.
 */
function isHookUnavailable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "server.unavailable";
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
  private readonly wsl: WorkspaceWslTransport;
  private readonly localChannelFactory: WorkspaceLocalChannelFactory;
  private readonly localAgentCommandResolver: WorkspaceLocalAgentCommandResolver;
  private readonly writeShimFiles: WriteShimFilesFn;
  private readonly removeShimDir: RemoveShimDirFn;

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

  /**
   * Callback to restore held PTY sessions after a successful re-authentication.
   * Injected from main/index.ts after construction to break the circular dep.
   * Manager calls this immediately after ensureRemoteProviderReady resolves on a
   * reauth path.
   */
  private ptyRestoreAfterReauth: ((workspaceId: string) => Promise<void>) | null = null;

  /**
   * Callback to release held PTY sessions when re-authentication will not be
   * attempted (auth-cancelled, backoff exhausted, non-interactive, ctx gone).
   * Injected from main/index.ts after construction to break the circular dep.
   * Manager calls this on every terminal failure path that does NOT reauth.
   */
  private ptyReleaseHeld: ((workspaceId: string) => void) | null = null;

  /**
   * Optional async callback invoked by `remove()` after the PTY sessions are
   * closed and before the workspace:removed broadcast. Injected after
   * construction (see `setBrowserCloser`) so the browser registry and
   * WorkspaceManager can be wired without a circular import.
   * When set, remove() awaits this to destroy all browser views and clear the
   * workspace's storage partition before the context is deleted.
   */
  private browserCloser: ((workspaceId: string) => Promise<void>) | null = null;

  private readonly providerReadyListeners = new Set<
    (workspaceId: string, provider: FsProvider) => void
  >();

  private readonly contexts = new Map<string, WorkspaceContext>();
  private readonly localChannels = new Map<string, AgentChannel>();
  private readonly localProviderReady = new Map<string, Promise<void>>();
  private readonly sshChannels = new Map<string, SshChannel>();
  /** Channels of removed workspaces, kept open until their agent exits. */
  private readonly stoppingSshChannels = new Set<SshChannel>();
  /**
   * Other daemons a connected agent is stopping, by its channel. Its own
   * stop waits for them: its agent exits, and drops them, once it answers.
   */
  private readonly peerDaemonStops = new Map<SshChannel, Promise<void>>();
  /**
   * Stops of removed remote workspaces' daemons, by location. A workspace
   * on that location connects once they have ended: the daemon is one per
   * folder, so a stop that ends after it connects stops its terminals, and
   * a removed workspace's channel still reconnecting takes the daemon over.
   */
  private readonly daemonStopsByLocation = new Map<string, Promise<void>>();
  private readonly sshBootstraps = new Map<string, EnsureRemoteAgentResult>();
  /** Bootstrap still owns its SSH/WSL processes until it hands off the channel. */
  private readonly remoteBootstrapControllers = new Map<string, AbortController>();
  private readonly sshProviderReady = new Map<string, Promise<void>>();
  // ControlMasters handed off from an SSH browse session, keyed by workspace
  // id, awaiting their first provider boot. Consumed by startRemoteProvider.
  private readonly adoptedSshMasters = new Map<string, SshControlMaster>();
  private readonly connectionStatuses = new Map<string, WorkspaceConnectionEventStatus>();
  // Cache of pull-based hookserver connection info — filled by the hook.getInfo RPC right after channel.ready.
  private readonly hookInfoByWorkspace = new Map<string, HookInfo>();
  /** One wait per local reconnect, until the replacement's hooks are known. */
  private readonly localHookRefreshes = new WeakMap<AgentChannel, LocalHookRefresh>();
  /** One retry loop per workspace, including the gaps between attempts. */
  private readonly sshReauth = new Map<
    string,
    { controller: AbortController; ready: Promise<void> }
  >();
  /**
   * Pending timers for `degraded-recovered` debounce.
   * Clears the "unstable" badge ~1 s after the last heartbeat recovery signal
   * to prevent rapid unstable↔connected flapping.
   */
  private readonly degradedRecoveryTimers = new Map<string, NodeJS.Timeout>();
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
    this.sshChannelFactory = sshChannelFactory;
    this.sshBootstrap = sshBootstrap;
    this.sshLspBootstrap = sshLspBootstrap;
    this.localChannelFactory = localChannelFactory;
    this.localAgentCommandResolver = localAgentCommandResolver;
    this.writeShimFiles = writeShimFiles;
    this.removeShimDir = removeShimDir;
    this.wsl = wsl;
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
      this.remoteBootstrapControllers.get(id)?.abort(createWorkspaceRemovedError(id));
      this.cancelSshReauth(id);
      this.clearDegradedRecovery(id);
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
    for (const bootstrap of this.sshBootstraps.values()) {
      bootstrap.dispose?.();
    }
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
    return this.hookInfoByWorkspace.get(workspaceId) ?? null;
  }

  /** Returns the hooks for the channel about to start a chat or terminal. */
  async getSpawnHookInfo(workspaceId: string, channel: AgentChannel): Promise<HookInfo | null> {
    let refresh = this.localHookRefreshes.get(channel);
    while (refresh) {
      await refresh.promise;
      refresh = this.localHookRefreshes.get(channel);
    }
    if ((this.localChannels.get(workspaceId) ?? this.sshChannels.get(workspaceId)) !== channel) {
      throw new Error(`agent channel changed for workspace: ${workspaceId}`);
    }
    return this.getHookInfo(workspaceId);
  }

  /** Reads the hook endpoint, allowing workspaces whose agent cannot host hooks. */
  private async readHookInfo(workspaceId: string, channel: AgentChannel): Promise<HookInfo | null> {
    try {
      const raw = await channel.call("hook.getInfo", {});
      if (!isHookInfo(raw)) throw new Error("hook.getInfo returned no socketPath or token");
      return raw;
    } catch (error) {
      if (!isHookUnavailable(error)) throw error;
      log.warn(
        `hookserver unavailable for ${workspaceId}; hook integration disabled for this session.`,
      );
      return null;
    }
  }

  /** Installs the current agent's endpoint or clears it when hooks are unavailable. */
  private cacheHookInfo(workspaceId: string, info: HookInfo | null): void {
    if (info) this.hookInfoByWorkspace.set(workspaceId, info);
    else this.hookInfoByWorkspace.delete(workspaceId);
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
    const bootstrap = this.sshBootstraps.get(workspaceId);
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
    const bootstrap = this.sshBootstraps.get(workspaceId);
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
    const bootstrap = this.sshBootstraps.get(workspaceId);
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
    const bootstrap = this.sshBootstraps.get(workspaceId);
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
    const bootstrap = this.sshBootstraps.get(workspaceId);
    if (!bootstrap) return null;
    return absoluteRemotePath(bootstrap.remoteHome, `${REMOTE_AGENT_ROOT}/worktrees`);
  }

  async tryGetAgentChannel(id: string): Promise<AgentChannel | null> {
    if (!this.contexts.has(id)) return null;
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
    const status = this.connectionStatuses.get(id);
    if (status !== "connected" && status !== "unstable") return null;
    return this.sshChannels.get(id) ?? null;
  }

  /**
   * An SSH workspace's host and, while it is connected, the connection its
   * ports are forwarded over: its ControlMaster, or none for key-only auth.
   * Null for a workspace that is not on an SSH host.
   */
  getSshForwarding(id: string): SshForwarding | null {
    const location = this.contexts.get(id)?.getMeta().location;
    if (location?.kind !== "ssh") return null;
    const status = this.connectionStatuses.get(id);
    const bootstrap = this.sshBootstraps.get(id);
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
    this.ptyRestoreAfterReauth = restoreAfterReauth;
    this.ptyReleaseHeld = releaseHeld;
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
    this.providerReadyListeners.add(listener);
    return () => {
      this.providerReadyListeners.delete(listener);
    };
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
      colorTone: "default",
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
    this.adoptedSshMasters.get(workspaceId)?.dispose();
    this.adoptedSshMasters.set(workspaceId, master);
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

  remove(id: string): void {
    const ctx = this.contexts.get(id);
    if (!ctx) {
      return;
    }

    // A workspace's tasks go with it. Their worktrees stay on disk; git
    // forgets one once its folder is deleted (`git worktree prune`).
    for (const task of this.list()) {
      if (task.task?.parentId === id) this.remove(task.id);
    }

    // Step 1 — terminate all PTY sessions for this workspace *before* the
    // context is deleted. This prevents the renderer's post-removal pty.kill
    // IPC calls from reaching `requireContext` on a missing workspace and
    // producing spurious "Error occurred in handler for 'ipc:call'" logs.
    // The PTY host emits pty.exit events for each live session so the
    // renderer's dead-terminal banner fires without waiting for IPC.
    this.ptySessionCloser?.(id);
    this.remoteBootstrapControllers.get(id)?.abort(createWorkspaceRemovedError(id));
    this.cancelSshReauth(id);
    this.clearDegradedRecovery(id);

    // Step 1b — destroy all browser views for this workspace and schedule
    // clearStorageData. View destroys happen synchronously inside the async
    // closer before the first await, so they complete before the context is
    // deleted below. clearStorageData is fire-and-forget relative to remove().
    if (this.browserCloser) {
      void this.browserCloser(id).catch((err: unknown) => {
        log.warn(`browser closer failed for ${id}: ${(err as Error).message}`);
      });
    }

    // Step 1c — a removed workspace's remote agent will not be dialed again,
    // so it is asked to exit. Its channel stays open for that, past the
    // provider teardown in ctx.close(), and after the daemons it is
    // stopping for others. One reconnecting is asked once its link is back.
    // One not connected, or whose agent cannot be reached, is stopped by
    // another agent on its host, if one is connected.
    const sshChannel = this.sshChannels.get(id);
    if (sshChannel) {
      this.stoppingSshChannels.add(sshChannel);
      const bootstrap = this.sshBootstraps.get(id);
      const meta = ctx.getMeta();
      const stop = async () => {
        if (!(await stopSshAgent(sshChannel, bootstrap))) this.stopDaemonThroughPeer(meta);
      };
      const pending = this.peerDaemonStops.get(sshChannel);
      const stopping = (pending ? pending.then(stop) : stop()).finally(() => {
        this.stoppingSshChannels.delete(sshChannel);
      });
      this.trackDaemonStop(meta.location, stopping);
    } else {
      this.stopDaemonThroughPeer(ctx.getMeta());
    }

    // Step 2 — dispose the workspace storage handle and agent channels.
    ctx.close();
    this.contexts.delete(id);
    this.localChannels.get(id)?.dispose();
    this.localChannels.delete(id);
    this.localProviderReady.delete(id);
    this.sshChannels.delete(id);
    this.sshBootstraps.delete(id);
    this.sshProviderReady.delete(id);
    // An adopted master never consumed by a provider boot would otherwise
    // leak its ssh process.
    this.adoptedSshMasters.get(id)?.dispose();
    this.adoptedSshMasters.delete(id);
    // The hookserver connection info is deleted together with the workspace.
    this.hookInfoByWorkspace.delete(id);
    this.removeShimDirQuietly(id);
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
    this.connectionStatuses.delete(id);
  }

  /**
   * Asks another connected agent on the removed remote workspace's host —
   * its parent's first — to stop that workspace's daemon, which may still
   * run its terminals from an earlier connection.
   */
  private stopDaemonThroughPeer(meta: WorkspaceMeta): void {
    const { location } = meta;
    if (location.kind === "local") return;
    const channel = this.connectedPeerChannel(meta);
    if (!channel) return;
    const stop = stopPeerDaemon(channel, location.remotePath);
    this.trackDaemonStop(location, stop);
    const pending = this.peerDaemonStops.get(channel);
    const all = pending ? Promise.all([pending, stop]).then(() => {}) : stop;
    this.peerDaemonStops.set(channel, all);
    void all.finally(() => {
      if (this.peerDaemonStops.get(channel) === all) this.peerDaemonStops.delete(channel);
    });
  }

  /** Notes a stop of the daemon at `location`, which a new connection there waits for. */
  private trackDaemonStop(location: WorkspaceLocation, stop: Promise<unknown>): void {
    const key = workspaceLocationKey(location);
    const pending = this.daemonStopsByLocation.get(key);
    const all = (pending ? Promise.all([pending, stop]) : stop).then(
      () => {},
      () => {},
    );
    this.daemonStopsByLocation.set(key, all);
    void all.then(() => {
      if (this.daemonStopsByLocation.get(key) === all) this.daemonStopsByLocation.delete(key);
    });
  }

  /**
   * Waits for the stops of a removed workspace's daemon at `location`, one
   * tracked meanwhile (a peer asked after its own agent could not be
   * reached) included.
   */
  private async daemonStopped(location: WorkspaceLocation): Promise<void> {
    const key = workspaceLocationKey(location);
    for (;;) {
      const pending = this.daemonStopsByLocation.get(key);
      if (!pending) return;
      await pending;
    }
  }

  /** The channel of a connected workspace on `meta`'s host other than its own daemon's. */
  private connectedPeerChannel(meta: WorkspaceMeta): SshChannel | undefined {
    const { location } = meta;
    if (location.kind === "local") return undefined;
    const ids = [meta.task?.parentId, ...this.contexts.keys()];
    for (const id of ids) {
      if (id === undefined || id === meta.id) continue;
      const other = this.contexts.get(id)?.getMeta().location;
      const channel = this.sshChannels.get(id);
      const status = this.connectionStatuses.get(id);
      if (!other || other.kind === "local" || !channel) continue;
      if (status !== "connected" && status !== "unstable") continue;
      if (this.stoppingSshChannels.has(channel)) continue;
      if (!sameRemoteHost(other, location) || other.remotePath === location.remotePath) continue;
      return channel;
    }
    return undefined;
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
    await this.ensureRemoteProviderReady(ctx);
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

    try {
      const info = await this.readHookInfo(meta.id, channel);
      if (this.localChannels.get(meta.id) === channel && !this.localHookRefreshes.has(channel)) {
        this.cacheHookInfo(meta.id, info);
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
      await this.writeShimFiles(meta.id);
    } catch (shimErr) {
      log.warn(
        `shim file write failed for ${meta.id}; shell PATH priority may be degraded: ${(shimErr as Error).message}`,
      );
    }

    if (!this.isLiveContext(meta.id, ctx)) {
      disposeLifecycleListener();
      channel.dispose();
      // remove() already deleted the shim dir; this boot rewrote it.
      this.removeShimDirQuietly(meta.id);
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
    this.notifyProviderReady(meta.id, provider);
  }

  /**
   * Lazily connects one SSH or WSL channel per workspace and injects it into
   * the context.
   */
  private async ensureRemoteProviderReady(ctx: WorkspaceContext, reauth = false): Promise<void> {
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      return;
    }

    const recovery = this.sshReauth.get(meta.id);
    if (recovery && !reauth) {
      await recovery.ready;
      return;
    }

    const pending = this.sshProviderReady.get(meta.id);
    if (pending) {
      await pending;
      return;
    }

    const ready = this.startRemoteProvider(ctx, meta);
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
   * Owns the explicit remote boot sequence: bootstrap → spawn → ready →
   * context provider. A WSL workspace takes it like an SSH one; only the
   * bootstrap and the channel's transport differ.
   */
  private async startRemoteProvider(ctx: WorkspaceContext, meta: WorkspaceMeta): Promise<void> {
    const location = meta.location;
    if (location.kind === "local") {
      return;
    }

    this.broadcastConnectionStatus(meta.id, "connecting");
    // A workspace removed and added again connects once its old daemon has
    // been stopped, not to it as that stop ends.
    await this.daemonStopped(location);
    if (!this.isLiveContext(meta.id, ctx)) throw createWorkspaceRemovedError(meta.id);
    // A workspace created from a browse session inherits that session's
    // already-authenticated ControlMaster; reusing its socket lets bootstrap
    // skip the interactive auth round entirely (no second password prompt).
    const adoptedMaster = this.adoptedSshMasters.get(meta.id);
    this.adoptedSshMasters.delete(meta.id);
    const controller = new AbortController();
    this.remoteBootstrapControllers.set(meta.id, controller);
    const signal = controller.signal;
    let bootstrap: EnsureRemoteAgentResult;
    const onProgress = (event: LspBootstrapProgressEvent) => {
      if (!signal.aborted) this.broadcastConnectionProgress(meta.id, event);
    };
    try {
      bootstrap =
        location.kind === "wsl"
          ? await this.wsl.bootstrap(
              {
                distro: location.distro,
                remotePath: location.remotePath,
                cachedRemoteArch: location.remoteArch,
                workspaceId: meta.id,
                signal,
              },
              { onProgress },
            )
          : await this.sshBootstrap(
              {
                host: location.host,
                user: location.user,
                port: location.port,
                identityFile: location.identityFile,
                authMode: location.authMode,
                remotePath: location.remotePath,
                cachedRemoteArch: location.remoteArch,
                controlPath: adoptedMaster?.controlPath,
                // Pass workspaceId so the bootstrap also uploads the shim rc
                // files (`.zshrc`/`.zshenv`/`bashrc`) into the remote's shared
                // `~/.nexus-code/shim/shared/`, making them available to the
                // remote PTY's zsh `ZDOTDIR` / bash `--rcfile` activation.
                workspaceId: meta.id,
                signal,
              },
              { onProgress },
            );
    } catch (error) {
      // Bootstrap failed before any channel existed. Release the adopted
      // master (we own it now) and surface the error state instead of
      // leaving the renderer stuck on "connecting".
      adoptedMaster?.dispose();
      if (!this.isLiveContext(meta.id, ctx)) throw createWorkspaceRemovedError(meta.id);
      if (!this.sshReauth.has(meta.id)) this.broadcastConnectionStatus(meta.id, "error");
      throw error;
    } finally {
      this.remoteBootstrapControllers.delete(meta.id);
    }
    // ensureRemoteAgent only returns a dispose handle for a master it
    // authenticated itself. When we supplied an adopted master, wire its
    // dispose in so the existing teardown paths release that socket too.
    if (adoptedMaster && !bootstrap.dispose) {
      bootstrap = { ...bootstrap, dispose: () => adoptedMaster.dispose() };
    }
    // The bootstrap can span a password prompt and an agent upload; the
    // workspace may have been removed meanwhile, and nothing would dispose a
    // channel or master created for it from here on.
    if (!this.isLiveContext(meta.id, ctx)) {
      bootstrap.dispose?.();
      throw createWorkspaceRemovedError(meta.id);
    }
    let providerMeta = meta;
    if (!location.remoteArch) {
      providerMeta = {
        ...meta,
        location:
          location.kind === "wsl"
            ? { ...location, remoteArch: { os: "linux", arch: bootstrap.platform.arch } }
            : { ...location, remoteArch: bootstrap.platform },
      };
      this.globalStorage.updateWorkspace(meta.id, { location: providerMeta.location });
      ctx.setMeta(providerMeta);
      this.broadcastFn("workspace", "changed", providerMeta);
    }
    if (!this.isLiveContext(meta.id, ctx)) {
      bootstrap.dispose?.();
      throw createWorkspaceRemovedError(meta.id);
    }
    let channel: SshChannel;
    try {
      channel =
        location.kind === "wsl"
          ? this.wsl.createChannel({
              distro: location.distro,
              remoteCommand: bootstrap.remoteCommand,
            })
          : this.sshChannelFactory(
              sshChannelOptionsFromLocation(
                { ...location, remoteArch: bootstrap.platform },
                bootstrap.remoteCommand,
                bootstrap.controlPath,
              ),
            );
    } catch (error) {
      bootstrap.dispose?.();
      if (!this.sshReauth.has(meta.id)) this.broadcastConnectionStatus(meta.id, "error");
      throw error;
    }
    this.sshBootstraps.set(meta.id, bootstrap);
    this.sshChannels.set(meta.id, channel);
    let installed = false;
    let bootFailure: Error | undefined;
    const disposeLifecycleListener = channel.onLifecycle((event) => {
      if (installed) this.handleSshChannelLifecycle(meta.id, channel, event);
      else if (event.type === "failure") bootFailure = event.error;
      else if (event.type === "exit" || event.type === "held-then-expired") {
        bootFailure = new Error("Agent connection ended during provider setup");
      }
    });

    /** Checks ownership after each asynchronous stage of provider setup. */
    const checkBoot = () => {
      if (!this.isLiveContext(meta.id, ctx)) throw createWorkspaceRemovedError(meta.id);
      if (bootFailure) throw bootFailure;
    };
    let shimStarted = false;
    try {
      await channel.ready;
      checkBoot();

      let info: HookInfo | null;
      try {
        info = await this.readHookInfo(meta.id, channel);
      } catch (error) {
        checkBoot();
        log.warn(`agent hook setup failed for ${meta.id}: ${(error as Error).message}`);
        throw new Error(`Agent hook setup failed: ${(error as Error).message}`, { cause: error });
      }
      checkBoot();
      if (this.sshChannels.get(meta.id) === channel) this.cacheHookInfo(meta.id, info);

      // The remote workspace's local shim supplies env/args for local PTYs.
      shimStarted = true;
      try {
        await this.writeShimFiles(meta.id);
      } catch (error) {
        log.warn(
          `shim file write failed for ${meta.id}; shell PATH priority may be degraded: ${(error as Error).message}`,
        );
      }
      checkBoot();
    } catch (error) {
      disposeLifecycleListener();
      if (shimStarted) this.removeShimDirQuietly(meta.id);
      if (!this.isLiveContext(meta.id, ctx)) throw createWorkspaceRemovedError(meta.id);
      this.sshChannels.delete(meta.id);
      this.sshBootstraps.delete(meta.id);
      this.hookInfoByWorkspace.delete(meta.id);
      channel.dispose();
      bootstrap.dispose?.();
      if (!this.sshReauth.has(meta.id)) this.broadcastConnectionStatus(meta.id, "error");
      throw error;
    }

    installed = true;
    const provider = createFsProvider(providerMeta, channel);
    ctx.setFsProvider(provider, () => {
      disposeLifecycleListener();
      // remove() closes a channel it is stopping once the agent has exited.
      if (!this.stoppingSshChannels.has(channel)) {
        channel.dispose();
        bootstrap.dispose?.();
      }
      if (this.sshChannels.get(meta.id) === channel) {
        this.sshChannels.delete(meta.id);
      }
      this.sshBootstraps.delete(meta.id);
      this.sshProviderReady.delete(meta.id);
      // A terminal status set just before teardown says why the provider
      // went away; "disconnected" would hide the error or session-expired UI.
      const status = this.connectionStatuses.get(meta.id);
      if (status !== "error" && status !== "held-then-expired") {
        this.broadcastConnectionStatus(meta.id, "disconnected");
      }
    });
    this.broadcastConnectionStatus(meta.id, "connected");
    this.notifyProviderReady(meta.id, provider);
  }

  /**
   * True while `ctx` is still the open context for `id`, i.e. the workspace
   * was not removed during an await in a provider boot.
   */
  private isLiveContext(id: string, ctx: WorkspaceContext): boolean {
    return this.contexts.get(id) === ctx;
  }

  /** Deletes the workspace's PTY shim directory in the background. */
  private removeShimDirQuietly(id: string): void {
    this.removeShimDir(id).catch((err: unknown) => {
      log.warn(`shim dir removal failed for ${id}: ${(err as Error).message}`);
    });
  }

  /**
   * Runs the provider-ready listeners; one that throws does not skip the rest.
   */
  private notifyProviderReady(workspaceId: string, provider: FsProvider): void {
    for (const listener of this.providerReadyListeners) {
      try {
        listener(workspaceId, provider);
      } catch (error) {
        log.warn(`provider-ready listener failed for ${workspaceId}: ${(error as Error).message}`);
      }
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
   * Forwards agent bootstrap progress events to the renderer.
   * Scoped by workspaceId, so it covers both the "add new workspace" and "reconnect at app start" flows.
   */
  private broadcastConnectionProgress(workspaceId: string, event: LspBootstrapProgressEvent): void {
    this.broadcastFn("workspace", "connectionProgress", {
      workspaceId,
      name: event.name,
      phase: event.phase,
      bytesDone: event.bytesDone,
      bytesTotal: event.bytesTotal,
    });
  }

  /**
   * Handles terminal SSH channel lifecycle events and restores the inert SSH provider.
   *
   * Reattach-aware transitions:
   *   - `degraded`: 1 missed heartbeat → broadcast "unstable" (workspaceIsOnline stays true).
   *   - `degraded-recovered`: heartbeat restored → debounce ~1 s then broadcast "connected"
   *     to prevent rapid unstable↔connected flapping.
   *   - `reconnecting`: transient — channel may yet recover; keep references, broadcast
   *     "reconnecting" so the renderer shows the hold overlay.
   *   - `ready` (epoch-match): session restored — broadcast "connected" and clear unstable.
   *   - `held-then-expired`: daemon replaced — broadcast "held-then-expired" so the renderer
   *     shows "session expired" rather than a generic error. Then tear down the provider.
   *   - `failure` / `exit`: terminal — if auth-failed on an interactive workspace, attempt
   *     automatic re-authentication with exponential backoff (plan issue 6).
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

    this.clearDegradedRecovery(workspaceId);

    // ── Transient quality events ──────────────────────────────────────────
    if (event.type === "degraded") {
      this.broadcastConnectionStatus(workspaceId, "unstable");
      return;
    }

    if (event.type === "degraded-recovered") {
      // ~1 s debounce recommended by designer (plan issue 5) to prevent flapping.
      const timer = setTimeout(() => {
        this.degradedRecoveryTimers.delete(workspaceId);
        if (this.sshChannels.get(workspaceId) === channel) {
          this.broadcastConnectionStatus(workspaceId, "connected");
        }
      }, 1000);
      timer.unref?.();
      this.degradedRecoveryTimers.set(workspaceId, timer);
      return;
    }

    // ── Reconnecting: keep references, update UI ──────────────────────────
    if (event.type === "reconnecting") {
      this.broadcastConnectionStatus(workspaceId, "reconnecting");
      return;
    }

    // ── Epoch-match reattach ──────────────────────────────────────────────
    if (event.type === "ready") {
      // Channel recovered with the same daemon — sessions are being restored
      // by agent-host. Broadcast "connected" to clear the reconnecting overlay.
      this.broadcastConnectionStatus(workspaceId, "connected");
      return;
    }

    // ── Held-then-expired: daemon replaced ───────────────────────────────
    if (event.type === "held-then-expired") {
      this.broadcastConnectionStatus(workspaceId, "held-then-expired");
      this.tearDownSshProvider(workspaceId, ctx);
      return;
    }

    // ── Terminal events: failure / exit ───────────────────────────────────
    const isAuthFailure =
      event.type === "failure" && (event.error as { code?: string }).code === "ssh.auth-failed";
    const meta = ctx.getMeta();
    const isInteractive = meta.location.kind === "ssh" && meta.location.authMode === "interactive";

    if (event.type === "failure" && !isAuthFailure) {
      this.broadcastConnectionStatus(workspaceId, "error");
    }

    this.tearDownSshProvider(workspaceId, ctx);

    if (isAuthFailure && isInteractive && this.isLiveContext(workspaceId, ctx)) {
      this.startSshReauth(ctx);
      return;
    }

    // No reauth attempted: release any held PTY sessions so they don't leak.
    this.ptyReleaseHeld?.(workspaceId);
  }

  /**
   * Tears down SSH provider state after a terminal channel event.
   * Shared by `failure`, `exit`, and `held-then-expired` paths.
   */
  private tearDownSshProvider(workspaceId: string, ctx: WorkspaceContext): void {
    this.sshChannels.delete(workspaceId);
    this.sshBootstraps.delete(workspaceId);
    this.sshProviderReady.delete(workspaceId);
    // Stale hookInfo is invalid once the channel dies — the next boot fills it again.
    this.hookInfoByWorkspace.delete(workspaceId);
    ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
    // Clean up the PTY shim directory — fire-and-forget, errors are swallowed as a warn.
    this.removeShimDir(workspaceId).catch((err: unknown) => {
      log.warn(`shim dir removal failed for ${workspaceId}: ${(err as Error).message}`);
    });
  }

  /** Cancels a delayed transition back to connected. */
  private clearDegradedRecovery(workspaceId: string): void {
    clearTimeout(this.degradedRecoveryTimers.get(workspaceId));
    this.degradedRecoveryTimers.delete(workspaceId);
  }

  /** Owns the held PTYs until automatic SSH reauthentication is resolved. */
  private startSshReauth(ctx: WorkspaceContext): void {
    const { id } = ctx.getMeta();
    if (this.sshReauth.has(id)) return;
    const controller = new AbortController();
    const ready = Promise.resolve()
      .then(() => this.retrySshReauth(ctx, controller.signal))
      .then(
        () => {
          if (controller.signal.aborted) throw createWorkspaceRemovedError(id);
          this.sshReauth.delete(id);
          this.ptyRestoreAfterReauth?.(id).catch((error: unknown) => {
            log.warn(`restoreAfterReauth failed for ${id}: ${(error as Error).message}`);
          });
        },
        (error: unknown) => {
          if (controller.signal.aborted) throw createWorkspaceRemovedError(id);
          this.sshReauth.delete(id);
          const cancelled = (error as { code?: string }).code === "ssh.auth-cancelled";
          this.broadcastConnectionStatus(id, cancelled ? "disconnected" : "error");
          this.ptyReleaseHeld?.(id);
          throw error;
        },
      );
    this.sshReauth.set(id, { controller, ready });
    // Automatic recovery can run without any caller awaiting it.
    void ready.catch(() => {});
  }

  /** Runs all attempts in order, keeping manual Connect on the same promise. */
  private async retrySshReauth(ctx: WorkspaceContext, signal: AbortSignal): Promise<void> {
    const { id } = ctx.getMeta();
    for (const [attempt, delay] of SSH_REAUTH_BACKOFF_MS.entries()) {
      if (delay > 0 && !signal.aborted) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, delay);
          timer.unref?.();
          signal.addEventListener("abort", finish, { once: true });
        });
      }
      if (signal.aborted) throw createWorkspaceRemovedError(id);
      try {
        await this.ensureRemoteProviderReady(ctx, true);
        return;
      } catch (error) {
        if (signal.aborted || (error as { code?: string }).code === "ssh.auth-cancelled") {
          throw error;
        }
        log.warn(`reauth attempt ${attempt + 1} failed for ${id}: ${(error as Error).message}`);
        if (attempt === SSH_REAUTH_BACKOFF_MS.length - 1) throw error;
      }
    }
  }

  /** Stops pending retries and releases held PTYs when the workspace closes. */
  private cancelSshReauth(workspaceId: string): void {
    const recovery = this.sshReauth.get(workspaceId);
    if (!recovery) return;
    this.sshReauth.delete(workspaceId);
    recovery.controller.abort();
    this.ptyReleaseHeld?.(workspaceId);
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
      this.hookInfoByWorkspace.delete(workspaceId);
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
    this.hookInfoByWorkspace.delete(workspaceId);
    ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
    // Clean up the PTY shim directory — fire-and-forget, errors are swallowed as a warn.
    this.removeShimDir(workspaceId).catch((err: unknown) => {
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
      const info = await this.readHookInfo(workspaceId, channel);
      if (this.localHookRefreshes.get(channel) !== refresh) return;
      this.cacheHookInfo(workspaceId, info);
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
