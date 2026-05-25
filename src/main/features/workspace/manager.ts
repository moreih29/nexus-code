import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isAbortError } from "../../../shared/abort";
import {
  rootPathFromLocation,
  type WorkspaceConnectionEventStatus,
  type WorkspaceLocation,
  workspaceLocationKey,
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
import {
  getAgentBinDir,
  getAgentBinaryPath,
} from "../../infra/agent/getAgentBinDir";
import {
  writeShimFiles as defaultWriteShimFiles,
  removeShimDir as defaultRemoveShimDir,
  shimDir,
} from "../../infra/agent/runtimeDirs";
import { AgentManifestSchema } from "../../../shared/agent/manifest";
import type { RemoteAgentPlatform } from "../../infra/agent/ssh/ssh-bootstrap/index";
import { LOCAL_AGENT_DIST_DIR } from "../../infra/agent/ssh/ssh-bootstrap/types";
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
// hook.getInfo 응답 타입 — pull 기반으로 워크스페이스별 hookserver 접속 정보를 보관한다.
// ---------------------------------------------------------------------------

/** agent가 hook.getInfo RPC로 반환하는 hookserver 접속 정보. */
export interface HookInfo {
  readonly socketPath: string;
  readonly token: string;
}

/**
 * hook.getInfo 응답 타입 가드.
 * socketPath / token 둘 다 문자열이어야 유효 응답으로 간주한다.
 */
function isHookInfo(value: unknown): value is HookInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.socketPath === "string" && typeof v.token === "string";
}

/**
 * `hook.getInfo` 응답이 `server.unavailable` 코드인지 판정한다.
 * agent 쪽에서 hookserver 생성에 실패한 graceful degrade 신호이며,
 * 워크스페이스 전체 boot를 죽이지 않고 Claude hook 기능만 비활성으로
 * 운영해야 한다. CodedError와 errorFromServerFrame이 `code` 속성을
 * Error에 attach하므로 그 값을 검사한다.
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
   * Optional async callback invoked by `remove()` after the PTY sessions are
   * closed and before the workspace:removed broadcast. Injected after
   * construction (see `setBrowserCloser`) so the browser registry and
   * WorkspaceManager can be wired without a circular import.
   * When set, remove() awaits this to destroy all browser views and clear the
   * workspace's storage partition before the context is deleted.
   */
  private browserCloser: ((workspaceId: string) => Promise<void>) | null = null;

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
  // pull 기반 hookserver 접속 정보 캐시 — channel.ready 직후 hook.getInfo RPC로 채워진다.
  private readonly hookInfoByWorkspace = new Map<string, HookInfo>();
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
    writeShimFiles: WriteShimFilesFn = defaultWriteShimFiles,
    removeShimDir: RemoveShimDirFn = defaultRemoveShimDir,
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
        console.error("[workspace] initial provider bootstrap failed", error);
      });
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
   * pull 기반으로 조회되어 메모리에 저장된 hookserver 접속 정보를 반환한다.
   * ensureProviderReady 완료 전이거나 RPC 실패 시 null을 반환한다.
   */
  getHookInfo(workspaceId: string): HookInfo | null {
    return this.hookInfoByWorkspace.get(workspaceId) ?? null;
  }

  /**
   * 워크스페이스 종류에 따라 래퍼 바이너리가 위치하는 bin 디렉터리의 절대 경로를 반환한다.
   *
   * - 로컬 워크스페이스: 로컬 배포 bin 디렉터리 (`getAgentBinDir()`)
   * - SSH 워크스페이스:  bootstrap 결과의 `remoteBinDir` (절대 경로)
   * - 워크스페이스 없음 / 채널 없음: null
   */
  getWrapperBinDir(workspaceId: string): string | null {
    const ctx = this.contexts.get(workspaceId);
    if (!ctx) return null;
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      return getAgentBinDir();
    }
    const bootstrap = this.sshBootstraps.get(workspaceId);
    if (!bootstrap) return null;
    return bootstrap.remoteBinDir;
  }

  /**
   * 워크스페이스 종류에 따라 에이전트 바이너리의 절대 경로를 반환한다.
   *
   * - 로컬 워크스페이스: 로컬 배포 agent 바이너리 경로 (`getAgentBinaryPath()`)
   * - SSH 워크스페이스:  `${remoteBinDir}/agent-<version>-<os>-<arch>` (bootstrap 결과에서 조립)
   * - 워크스페이스 없음 / bootstrap 없음: null
   */
  getWrapperAgentBin(workspaceId: string): string | null {
    const ctx = this.contexts.get(workspaceId);
    if (!ctx) return null;
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      return getAgentBinaryPath() ?? null;
    }
    const bootstrap = this.sshBootstraps.get(workspaceId);
    if (!bootstrap) return null;
    const { remoteBinDir, platform } = bootstrap;
    const binaryName = resolveRemoteAgentBinaryName(platform);
    if (!binaryName) return null;
    return `${remoteBinDir}/${binaryName}`;
  }

  /**
   * 워크스페이스의 PTY 셸-셤 디렉터리(=`.zshrc`/`.zshenv`/`bashrc` 끼움 파일이
   * 놓인 위치)의 절대 경로를 반환한다. `ipc.ts`의 spawn 핸들러가 이 값을
   * ZDOTDIR(zsh) 또는 `--rcfile`(bash) 인자로 사용한다.
   *
   * - 로컬 워크스페이스: 로컬 `~/.nexus-code/shim/<workspaceId>` (=`shimDir()`).
   *   끼움 파일들은 워크스페이스 부팅 시 `writeShimFiles()`로 이미 작성돼 있다.
   * - SSH 워크스페이스:  bootstrap이 부트스트랩 시점에 원격에 업로드한
   *   `<remoteHome>/.nexus-code/shim/<workspaceId>` 절대 경로
   *   (`bootstrap.remoteShimDir`). 부트스트랩 결과에 없으면 null —
   *   workspaceId 누락 또는 업로드 실패 케이스로, 셤 적용을 skip해야 함.
   * - 워크스페이스 없음: null
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
   * 워크스페이스 종류에 따라 그 워크스페이스의 PTY에서 사용할 로그인 셸의
   * 절대 경로를 반환한다. PTY 셸-셤(ZDOTDIR / --rcfile) 활성화 여부를 결정할 때
   * 사용된다.
   *
   * - 로컬 워크스페이스: `process.env.SHELL`. 없으면 `/bin/zsh`로 폴백.
   *   macOS Catalina(2019)부터 사용자 기본 셸이 zsh고, Finder/Spotlight로 띄운
   *   launchd 자식 프로세스는 `$SHELL`이 비어있을 수 있어서다.
   *   폴백이 zsh 한정인 이유는 zsh 셤 활성화가 `ZDOTDIR` **환경변수 주입**으로
   *   끝나기 때문 — 실제 셸이 bash/fish여도 그 env는 무시되므로 무해.
   *   (반면 bash 셤은 `--rcfile` 인자 주입이라 다른 셸에 잘못 박으면 깨짐.)
   * - SSH 워크스페이스:  bootstrap이 부트스트랩 시점에 remote에서 `$SHELL`을
   *   조회해둔 값. 없으면 null — 원격 셸을 모를 때 bash로 잘못 폴백하면
   *   원격 사용자의 fish/csh를 깨뜨릴 수 있어서 보수적으로 셤 skip.
   * - 워크스페이스 없음 / bootstrap 없음: null
   *
   * null 반환은 "셤 적용 건너뛰기" 신호다. 그 경우에도 spawn-time PATH prepend는
   * 그대로 살아있어서 wrapper bin은 PATH에 존재하지만, precmd 훅이 미등록되므로
   * 사용자 rc가 PATH를 재정렬하면 wrapper가 뒤로 밀릴 수 있다.
   */
  getWrapperShell(workspaceId: string): string | null {
    const ctx = this.contexts.get(workspaceId);
    if (!ctx) return null;
    const meta = ctx.getMeta();
    if (meta.location.kind === "local") {
      const shell = process.env.SHELL;
      return shell !== undefined && shell.length > 0 ? shell : "/bin/zsh";
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
    const sortOrder = this.globalStorage.nextTailSortOrder("unpinned");
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

    // Step 1 — terminate all PTY sessions for this workspace *before* the
    // context is deleted. This prevents the renderer's post-removal pty.kill
    // IPC calls from reaching `requireContext` on a missing workspace and
    // producing spurious "Error occurred in handler for 'ipc:call'" logs.
    // The PTY host emits pty.exit events for each live session so the
    // renderer's dead-terminal banner fires without waiting for IPC.
    this.ptySessionCloser?.(id);

    // Step 1b — destroy all browser views for this workspace and schedule
    // clearStorageData. View destroys happen synchronously inside the async
    // closer before the first await, so they complete before the context is
    // deleted below. clearStorageData is fire-and-forget relative to remove().
    if (this.browserCloser) {
      void this.browserCloser(id).catch((err: unknown) => {
        console.warn(
          `[workspace] browser closer failed for ${id}: ${(err as Error).message}`,
        );
      });
    }

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
    // hookserver 접속 정보는 워크스페이스 제거 시 함께 삭제한다.
    this.hookInfoByWorkspace.delete(id);
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
    // Explicit activation counts as "opening" the workspace — bump recency so
    // it sorts to the top of the list on the next load. Startup restoration
    // does not route through activate(), so it never reorders the list.
    this.touchLastOpened(id);
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

    // channel.ready 완료 직후 hook.getInfo를 pull해서 hookserver 접속 정보를 캐싱한다.
    // agent 내부에서 최대 5s 대기하므로 30s default timeout 안에 반드시 응답이 온다.
    //
    // server.unavailable 코드는 agent가 hookserver 생성에 실패한 graceful degrade
    // 신호다 — 워크스페이스 전체 boot를 죽이지 않고 hookInfo만 비운 채로 계속 진행한다.
    // (push 시절 동작과 동등: hookserver 없으면 Claude hook 기능만 꺼지고 워크스페이스는 정상)
    try {
      const raw = await channel.call("hook.getInfo", {});
      if (!isHookInfo(raw)) {
        throw new Error("hook.getInfo 응답이 올바르지 않음 (socketPath/token 누락)");
      }
      this.hookInfoByWorkspace.set(meta.id, raw);
    } catch (err) {
      if (isHookUnavailable(err)) {
        console.warn(
          `[workspace] hookserver unavailable for ${meta.id}; Claude Code hook integration disabled for this session.`,
        );
        this.hookInfoByWorkspace.delete(meta.id);
      } else {
        disposeLifecycleListener();
        if (this.localChannels.get(meta.id) === channel) {
          this.localChannels.delete(meta.id);
        }
        channel.dispose();
        ctx.setFsProvider(createInitialFsProvider(meta));
        throw new Error(
          `워크스페이스 ${meta.id} agent hook 초기화 실패: ${(err as Error).message}`,
        );
      }
    }

    // PTY shim 파일을 workspace-specific 디렉터리에 기록한다.
    // 실패해도 PATH 우선순위가 깨질 뿐 hook 자체는 settings.json 절대경로로 동작하므로
    // graceful warn 후 boot를 계속 진행한다.
    try {
      await this.writeShimFiles(meta.id);
    } catch (shimErr) {
      console.warn(
        `[workspace] shim file write failed for ${meta.id}; shell PATH priority may be degraded: ${(shimErr as Error).message}`,
      );
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
        // Pass workspaceId so the bootstrap also uploads the per-workspace
        // shim rc files (`.zshrc`/`.zshenv`/`bashrc`) into the remote's
        // `~/.nexus-code/shim/<workspaceId>/`, making them available to the
        // remote PTY's zsh `ZDOTDIR` / bash `--rcfile` activation.
        workspaceId: meta.id,
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

    // channel.ready 완료 직후 hook.getInfo를 pull해서 hookserver 접속 정보를 캐싱한다.
    // SSH 환경에서 latency가 더 클 수 있으나 30s default timeout이 충분하다.
    //
    // server.unavailable 코드는 agent가 hookserver 생성에 실패한 graceful degrade
    // 신호다. SSH 원격에서는 socket 경로 길이 제한(macOS 104자)에 걸릴 가능성이
    // 로컬보다 높으므로 graceful 처리가 특히 중요하다.
    try {
      const raw = await channel.call("hook.getInfo", {});
      if (!isHookInfo(raw)) {
        throw new Error("hook.getInfo 응답이 올바르지 않음 (socketPath/token 누락)");
      }
      this.hookInfoByWorkspace.set(meta.id, raw);
    } catch (err) {
      if (isHookUnavailable(err)) {
        console.warn(
          `[workspace] hookserver unavailable for ${meta.id}; Claude Code hook integration disabled for this session.`,
        );
        this.hookInfoByWorkspace.delete(meta.id);
      } else {
        disposeLifecycleListener();
        this.broadcastConnectionStatus(meta.id, "error");
        if (this.sshChannels.get(meta.id) === channel) {
          this.sshChannels.delete(meta.id);
        }
        this.sshBootstraps.delete(meta.id);
        bootstrap.dispose?.();
        channel.dispose();
        ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
        throw new Error(
          `워크스페이스 ${meta.id} agent hook 초기화 실패: ${(err as Error).message}`,
        );
      }
    }

    // PTY shim 파일을 workspace-specific 디렉터리에 기록한다.
    // SSH 워크스페이스의 shim은 로컬 프로세스용 — 원격 PATH 제어가 목적이 아니라
    // 로컬 PTY spawn 시 env/args 주입을 위한 것이다. 실패는 graceful warn.
    try {
      await this.writeShimFiles(meta.id);
    } catch (shimErr) {
      console.warn(
        `[workspace] shim file write failed for ${meta.id}; shell PATH priority may be degraded: ${(shimErr as Error).message}`,
      );
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
    // Stale hookInfo는 채널이 죽은 시점에 무효 — 다음 boot가 다시 채운다.
    // 보존해두면 reconnect 직후 spawn이 죽은 소켓 경로를 env에 박을 수 있다.
    this.hookInfoByWorkspace.delete(workspaceId);
    ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
    // PTY shim 디렉터리 정리 — fire-and-forget, error swallow는 warn으로.
    this.removeShimDir(workspaceId).catch((err: unknown) => {
      console.warn(
        `[workspace] shim dir removal failed for ${workspaceId}: ${(err as Error).message}`,
      );
    });
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
      // Stale hookInfo는 채널이 죽은 시점에 무효 — 다음 boot가 다시 채운다.
      // 보존해두면 reconnect 직후 spawn이 죽은 소켓 경로를 env에 박을 수 있다.
      this.hookInfoByWorkspace.delete(workspaceId);
      ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
      // PTY shim 디렉터리 정리 — fire-and-forget, error swallow는 warn으로.
      this.removeShimDir(workspaceId).catch((err: unknown) => {
        console.warn(
          `[workspace] shim dir removal failed for ${workspaceId}: ${(err as Error).message}`,
        );
      });
    }
  }
}

/**
 * Returns true when a workspace should auto-connect at app startup.
 * Local workspaces always connect immediately. SSH workspaces only connect
 * automatically when the authMode is "key-only"; interactive (password) SSH
 * workspaces restore in the disconnected state and connect on explicit user
 * action (sidebar click / panel Connect button) to avoid an unsolicited
 * password prompt during startup.
 */
function shouldAutoConnect(meta: WorkspaceMeta): boolean {
  if (meta.location.kind === "local") return true;
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
  const { app } = require("electron") as typeof import("electron");
  const distDir = app.isPackaged
    ? path.join(process.resourcesPath, "agent")
    : LOCAL_AGENT_DIST_DIR;
  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = AgentManifestSchema.parse(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    );
    return `agent-${manifest.version}-${platform.os}-${platform.arch}`;
  } catch {
    return null;
  }
}

