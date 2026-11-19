import { createLogger } from "../../../../shared/log/main";
import {
  type WorkspaceLocation,
  type WorkspaceMeta,
  workspaceLocationKey,
} from "../../../../shared/types/workspace";
import type {
  CreateSshChannelOptions,
  SshChannel,
  SshChannelLifecycleEvent,
} from "../../../infra/agent/ssh/channel";
import type { SshControlMaster } from "../../../infra/agent/ssh/master";
import type {
  EnsureRemoteAgentResult,
  LspBootstrapProgressEvent,
} from "../../../infra/agent/ssh/ssh-bootstrap/index";
import type { GlobalStorage } from "../../../infra/storage/global-storage";
import { createFsProvider } from "../../fs/bridge/create-provider";
import type { WorkspaceContext } from "../context";
import type { WorkspaceSshBootstrap, WorkspaceSshChannelFactory } from "../manager";
import type { HookInfo, WorkspaceHooks } from "./hooks";
import {
  createInitialFsProvider,
  createWorkspaceRemovedError,
  type WorkspaceConnectionState,
} from "./state";
import type { WorkspaceWslTransport } from "./wsl";

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

type SshWorkspaceLocation = Extract<WorkspaceLocation, { kind: "ssh" }>;

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

/** Owns SSH and WSL provider boot, reattachment and daemon shutdown. */
export class RemoteWorkspaceConnections {
  readonly sshChannels = new Map<string, SshChannel>();

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

  readonly sshBootstraps = new Map<string, EnsureRemoteAgentResult>();

  /** Bootstrap still owns its SSH/WSL processes until it hands off the channel. */
  private readonly remoteBootstrapControllers = new Map<string, AbortController>();

  private readonly sshProviderReady = new Map<string, Promise<void>>();

  // ControlMasters handed off from an SSH browse session, keyed by workspace
  // id, awaiting their first provider boot. Consumed by startRemoteProvider.
  private readonly adoptedSshMasters = new Map<string, SshControlMaster>();

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

  /**
   * Callback to restore held PTY sessions after a successful re-authentication.
   * Injected from main/index.ts after construction to break the circular dep.
   * Manager calls this immediately after ensureRemoteProviderReady resolves on a
   * reauth path.
   */
  ptyRestoreAfterReauth: ((workspaceId: string) => Promise<void>) | null = null;

  /**
   * Callback to release held PTY sessions when re-authentication will not be
   * attempted (auth-cancelled, backoff exhausted, non-interactive, ctx gone).
   * Injected from main/index.ts after construction to break the circular dep.
   * Manager calls this on every terminal failure path that does NOT reauth.
   */
  ptyReleaseHeld: ((workspaceId: string) => void) | null = null;

  constructor(
    private readonly state: WorkspaceConnectionState,
    private readonly hooks: WorkspaceHooks,
    private readonly globalStorage: GlobalStorage,
    private readonly sshChannelFactory: WorkspaceSshChannelFactory,
    private readonly sshBootstrap: WorkspaceSshBootstrap,
    private readonly wsl: WorkspaceWslTransport,
  ) {}

  /** Cancels workspace-specific bootstrap, retry and recovery work. */
  cancelPending(id: string): void {
    this.remoteBootstrapControllers.get(id)?.abort(createWorkspaceRemovedError(id));
    this.cancelSshReauth(id);
    this.clearDegradedRecovery(id);
  }

  /** Retains the channel long enough to stop a removed workspace's daemon. */
  stopRemovedAgent(id: string, ctx: WorkspaceContext): void {
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
  }

  /** Discards remote state after the removed workspace's context is closed. */
  remove(id: string): void {
    this.sshChannels.delete(id);
    this.sshBootstraps.delete(id);
    this.sshProviderReady.delete(id);
    // An adopted master never consumed by a provider boot would otherwise
    // leak its ssh process.
    this.adoptedSshMasters.get(id)?.dispose();
    this.adoptedSshMasters.delete(id);
  }

  /** Drops remote clients at app shutdown while keeping their daemons available. */
  close(): void {
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
    const ids = [meta.task?.parentId, ...this.state.contexts.keys()];
    for (const id of ids) {
      if (id === undefined || id === meta.id) continue;
      const other = this.state.contexts.get(id)?.getMeta().location;
      const channel = this.sshChannels.get(id);
      const status = this.state.connectionStatuses.get(id);
      if (!other || other.kind === "local" || !channel) continue;
      if (status !== "connected" && status !== "unstable") continue;
      if (this.stoppingSshChannels.has(channel)) continue;
      if (!sameRemoteHost(other, location) || other.remotePath === location.remotePath) continue;
      return channel;
    }
    return undefined;
  }

  /**
   * Lazily connects one SSH or WSL channel per workspace and injects it into
   * the context.
   */
  async ensureRemoteProviderReady(ctx: WorkspaceContext, reauth = false): Promise<void> {
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

    this.state.broadcastConnectionStatus(meta.id, "connecting");
    // A workspace removed and added again connects once its old daemon has
    // been stopped, not to it as that stop ends.
    await this.daemonStopped(location);
    if (!this.state.isLiveContext(meta.id, ctx)) throw createWorkspaceRemovedError(meta.id);
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
      if (!signal.aborted) this.state.broadcastConnectionProgress(meta.id, event);
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
      if (!this.state.isLiveContext(meta.id, ctx)) throw createWorkspaceRemovedError(meta.id);
      if (!this.sshReauth.has(meta.id)) this.state.broadcastConnectionStatus(meta.id, "error");
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
    if (!this.state.isLiveContext(meta.id, ctx)) {
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
      this.state.broadcastFn("workspace", "changed", providerMeta);
    }
    if (!this.state.isLiveContext(meta.id, ctx)) {
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
      if (!this.sshReauth.has(meta.id)) this.state.broadcastConnectionStatus(meta.id, "error");
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
      if (!this.state.isLiveContext(meta.id, ctx)) throw createWorkspaceRemovedError(meta.id);
      if (bootFailure) throw bootFailure;
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
      if (this.sshChannels.get(meta.id) === channel) this.hooks.cacheHookInfo(meta.id, info);

      // The remote workspace's local shim supplies env/args for local PTYs.
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
      if (shimStarted) this.state.removeShimDirQuietly(meta.id);
      if (!this.state.isLiveContext(meta.id, ctx)) throw createWorkspaceRemovedError(meta.id);
      this.sshChannels.delete(meta.id);
      this.sshBootstraps.delete(meta.id);
      this.hooks.clear(meta.id);
      channel.dispose();
      bootstrap.dispose?.();
      if (!this.sshReauth.has(meta.id)) this.state.broadcastConnectionStatus(meta.id, "error");
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
      const status = this.state.connectionStatuses.get(meta.id);
      if (status !== "error" && status !== "held-then-expired") {
        this.state.broadcastConnectionStatus(meta.id, "disconnected");
      }
    });
    this.state.broadcastConnectionStatus(meta.id, "connected");
    this.state.notifyProviderReady(meta.id, provider);
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

    const ctx = this.state.contexts.get(workspaceId);
    if (!ctx) {
      this.sshChannels.delete(workspaceId);
      this.sshBootstraps.delete(workspaceId);
      return;
    }

    this.clearDegradedRecovery(workspaceId);

    // ── Transient quality events ──────────────────────────────────────────
    if (event.type === "degraded") {
      this.state.broadcastConnectionStatus(workspaceId, "unstable");
      return;
    }

    if (event.type === "degraded-recovered") {
      // ~1 s debounce recommended by designer (plan issue 5) to prevent flapping.
      const timer = setTimeout(() => {
        this.degradedRecoveryTimers.delete(workspaceId);
        if (this.sshChannels.get(workspaceId) === channel) {
          this.state.broadcastConnectionStatus(workspaceId, "connected");
        }
      }, 1000);
      timer.unref?.();
      this.degradedRecoveryTimers.set(workspaceId, timer);
      return;
    }

    // ── Reconnecting: keep references, update UI ──────────────────────────
    if (event.type === "reconnecting") {
      this.state.broadcastConnectionStatus(workspaceId, "reconnecting");
      return;
    }

    // ── Epoch-match reattach ──────────────────────────────────────────────
    if (event.type === "ready") {
      // Channel recovered with the same daemon — sessions are being restored
      // by agent-host. Broadcast "connected" to clear the reconnecting overlay.
      this.state.broadcastConnectionStatus(workspaceId, "connected");
      return;
    }

    // ── Held-then-expired: daemon replaced ───────────────────────────────
    if (event.type === "held-then-expired") {
      this.state.broadcastConnectionStatus(workspaceId, "held-then-expired");
      this.tearDownSshProvider(workspaceId, ctx);
      return;
    }

    // ── Terminal events: failure / exit ───────────────────────────────────
    const isAuthFailure =
      event.type === "failure" && (event.error as { code?: string }).code === "ssh.auth-failed";
    const meta = ctx.getMeta();
    const isInteractive = meta.location.kind === "ssh" && meta.location.authMode === "interactive";

    if (event.type === "failure" && !isAuthFailure) {
      this.state.broadcastConnectionStatus(workspaceId, "error");
    }

    this.tearDownSshProvider(workspaceId, ctx);

    if (isAuthFailure && isInteractive && this.state.isLiveContext(workspaceId, ctx)) {
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
    this.hooks.clear(workspaceId);
    ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
    // Clean up the PTY shim directory — fire-and-forget, errors are swallowed as a warn.
    this.state.removeShimDir(workspaceId).catch((err: unknown) => {
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
          this.state.broadcastConnectionStatus(id, cancelled ? "disconnected" : "error");
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
   * Adopts a ControlMaster handed off from an SSH directory-browse session.
   * The next SSH provider boot for this workspace reuses that socket, so the
   * user is not prompted for credentials a second time. Safe to call before
   * the provider boots; the master is consumed by startRemoteProvider.
   */
  adoptSshControlMaster(workspaceId: string, master: SshControlMaster): void {
    this.adoptedSshMasters.get(workspaceId)?.dispose();
    this.adoptedSshMasters.set(workspaceId, master);
  }
}
