import { createAbortError } from "../../../../shared/abort";
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

const SSH_REAUTH_BACKOFF_MS = [0, 5_000, 30_000];

const SSH_AGENT_SHUTDOWN_TIMEOUT_MS = 30_000;
const SSH_AGENT_SHUTDOWN_RETRY_MS = 250;
const SSH_PEER_DAEMON_STOP_TIMEOUT_MS = 5_000;

type SshWorkspaceLocation = Extract<WorkspaceLocation, { kind: "ssh" }>;

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

async function stopPeerDaemon(channel: SshChannel, root: string): Promise<void> {
  await channel
    .call("agent.stopDaemon", { root }, { timeoutMs: SSH_PEER_DAEMON_STOP_TIMEOUT_MS })
    .catch((error: unknown) => {
      log.warn(`agent.stopDaemon failed: ${(error as Error).message}`);
    });
}

function sameRemoteHost(a: WorkspaceLocation, b: WorkspaceLocation): boolean {
  if (a.kind === "ssh" && b.kind === "ssh") {
    return a.host === b.host && a.user === b.user && (a.port ?? 22) === (b.port ?? 22);
  }
  return a.kind === "wsl" && b.kind === "wsl" && a.distro === b.distro;
}

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

export class RemoteWorkspaceConnections {
  readonly sshChannels = new Map<string, SshChannel>();

  private readonly stoppingSshChannels = new Set<SshChannel>();

  private readonly peerDaemonStops = new Map<SshChannel, Promise<void>>();

  private readonly daemonStopsByLocation = new Map<string, Promise<void>>();

  readonly sshBootstraps = new Map<string, EnsureRemoteAgentResult>();

  private readonly remoteBootstrapControllers = new Map<string, AbortController>();

  private readonly sshProviderReady = new Map<string, Promise<void>>();

  private readonly adoptedSshMasters = new Map<string, SshControlMaster>();

  private readonly sshReauth = new Map<
    string,
    { controller: AbortController; ready: Promise<void> }
  >();

  private readonly degradedRecoveryTimers = new Map<string, NodeJS.Timeout>();

  ptyRestoreAfterReauth: ((workspaceId: string) => Promise<void>) | null = null;

  ptyReleaseHeld: ((workspaceId: string) => void) | null = null;

  constructor(
    private readonly state: WorkspaceConnectionState,
    private readonly hooks: WorkspaceHooks,
    private readonly globalStorage: GlobalStorage,
    private readonly sshChannelFactory: WorkspaceSshChannelFactory,
    private readonly sshBootstrap: WorkspaceSshBootstrap,
    private readonly wsl: WorkspaceWslTransport,
  ) {}

  cancelPending(id: string): void {
    this.remoteBootstrapControllers.get(id)?.abort(createWorkspaceRemovedError(id));
    this.cancelSshReauth(id);
    this.clearDegradedRecovery(id);
  }

  stopRemovedAgent(id: string, ctx: WorkspaceContext): void {
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

  remove(id: string): void {
    this.sshChannels.delete(id);
    this.sshBootstraps.delete(id);
    this.sshProviderReady.delete(id);
    this.adoptedSshMasters.get(id)?.dispose();
    this.adoptedSshMasters.delete(id);
  }

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

  private async daemonStopped(location: WorkspaceLocation): Promise<void> {
    const key = workspaceLocationKey(location);
    for (;;) {
      const pending = this.daemonStopsByLocation.get(key);
      if (!pending) return;
      await pending;
    }
  }

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

  private async startRemoteProvider(ctx: WorkspaceContext, meta: WorkspaceMeta): Promise<void> {
    const location = meta.location;
    if (location.kind === "local") {
      return;
    }

    this.state.broadcastConnectionStatus(meta.id, "connecting");
    await this.daemonStopped(location);
    if (!this.state.isLiveContext(meta.id, ctx)) throw createWorkspaceRemovedError(meta.id);
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
                workspaceId: meta.id,
                signal,
              },
              { onProgress },
            );
    } catch (error) {
      adoptedMaster?.dispose();
      if (!this.state.isLiveContext(meta.id, ctx)) throw createWorkspaceRemovedError(meta.id);
      if (!this.sshReauth.has(meta.id)) this.state.broadcastConnectionStatus(meta.id, "error");
      throw error;
    } finally {
      this.remoteBootstrapControllers.delete(meta.id);
    }
    if (adoptedMaster && !bootstrap.dispose) {
      bootstrap = { ...bootstrap, dispose: () => adoptedMaster.dispose() };
    }
    if (!this.state.isLiveContext(meta.id, ctx)) {
      bootstrap.dispose?.();
      throw createWorkspaceRemovedError(meta.id);
    }
    let providerMeta = ctx.getMeta();
    const currentLocation = providerMeta.location;
    if (
      currentLocation.kind === "local" ||
      workspaceLocationKey(currentLocation) !== workspaceLocationKey(location)
    ) {
      bootstrap.dispose?.();
      this.state.broadcastConnectionStatus(meta.id, "disconnected");
      throw createAbortError(`Workspace ${meta.id} moved while its agent was starting`);
    }
    if (!currentLocation.remoteArch) {
      providerMeta = {
        ...providerMeta,
        location:
          currentLocation.kind === "wsl"
            ? { ...currentLocation, remoteArch: { os: "linux", arch: bootstrap.platform.arch } }
            : { ...currentLocation, remoteArch: bootstrap.platform },
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
      if (!this.stoppingSshChannels.has(channel)) {
        channel.dispose();
        bootstrap.dispose?.();
      }
      if (this.sshChannels.get(meta.id) === channel) {
        this.sshChannels.delete(meta.id);
      }
      this.sshBootstraps.delete(meta.id);
      this.sshProviderReady.delete(meta.id);
      const status = this.state.connectionStatuses.get(meta.id);
      if (status !== "error" && status !== "held-then-expired") {
        this.state.broadcastConnectionStatus(meta.id, "disconnected");
      }
    });
    this.state.broadcastConnectionStatus(meta.id, "connected");
    this.state.notifyProviderReady(meta.id, provider);
  }

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

    if (event.type === "degraded") {
      this.state.broadcastConnectionStatus(workspaceId, "unstable");
      return;
    }

    if (event.type === "degraded-recovered") {
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

    if (event.type === "reconnecting") {
      this.state.broadcastConnectionStatus(workspaceId, "reconnecting");
      return;
    }

    if (event.type === "ready") {
      this.state.broadcastConnectionStatus(workspaceId, "connected");
      return;
    }

    if (event.type === "held-then-expired") {
      this.state.broadcastConnectionStatus(workspaceId, "held-then-expired");
      this.tearDownSshProvider(workspaceId, ctx);
      return;
    }

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

    this.ptyReleaseHeld?.(workspaceId);
  }

  private tearDownSshProvider(workspaceId: string, ctx: WorkspaceContext): void {
    this.sshChannels.delete(workspaceId);
    this.sshBootstraps.delete(workspaceId);
    this.sshProviderReady.delete(workspaceId);
    this.hooks.clear(workspaceId);
    ctx.setFsProvider(createInitialFsProvider(ctx.getMeta()));
    this.state.removeShimDir(workspaceId).catch((err: unknown) => {
      log.warn(`shim dir removal failed for ${workspaceId}: ${(err as Error).message}`);
    });
  }

  private clearDegradedRecovery(workspaceId: string): void {
    clearTimeout(this.degradedRecoveryTimers.get(workspaceId));
    this.degradedRecoveryTimers.delete(workspaceId);
  }

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
    void ready.catch(() => {});
  }

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

  private cancelSshReauth(workspaceId: string): void {
    const recovery = this.sshReauth.get(workspaceId);
    if (!recovery) return;
    this.sshReauth.delete(workspaceId);
    recovery.controller.abort();
    this.ptyReleaseHeld?.(workspaceId);
  }

  adoptSshControlMaster(workspaceId: string, master: SshControlMaster): void {
    this.adoptedSshMasters.get(workspaceId)?.dispose();
    this.adoptedSshMasters.set(workspaceId, master);
  }
}
