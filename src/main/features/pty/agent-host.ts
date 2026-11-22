import { TextDecoder } from "node:util";
import { createLogger } from "../../../shared/log/main";
import type { AgentChannel, ChannelLifecycleEvent } from "../../infra/agent/channel";
import type { HookInfo } from "../workspace/manager";
import { tabHookToken } from "../workspace/tab-token";
import type { PtyHostHandle } from "./types";

const log = createLogger("agent-host");

/**
 * How long a kill sent to bring the agent's sessions in line waits for the
 * session's exit before the tab's next spawn is sent: the agent answers the
 * kill before the session is gone, and a spawn sent then attaches to it.
 */
const KILL_EXIT_WAIT_MS = 3_000;

type EventCallback = (args: unknown) => void;

/** pty.spawn result; `attached` is set when the tab's session was already running. */
interface AgentSpawnResult {
  pid: number;
  attached?: boolean;
}

interface AgentPtySession {
  workspaceId: string;
  tabId: string;
  decoder: TextDecoder;
}

interface WorkspaceSubscription {
  channel: AgentChannel;
  disposers: Array<() => void>;
}

export interface AgentPtyWorkspaceManager {
  /**
   * Returns the ready agent channel for a workspace, booting it if needed.
   * Throws when the workspace is not found or the channel cannot be obtained.
   */
  getAgentChannel(workspaceId: string): Promise<AgentChannel>;
  /**
   * Returns the agent channel for a workspace without throwing when the
   * workspace is not found. Returns `null` when the workspace context does
   * not exist — used by PTY paths where a missing workspace is a normal
   * racing condition rather than a bug.
   */
  tryGetAgentChannel(workspaceId: string): Promise<AgentChannel | null>;
  /** The current process's hook endpoint for a wrapped terminal spawn. */
  getSpawnHookInfo?(workspaceId: string, channel: AgentChannel): Promise<HookInfo | null>;
  /**
   * Tells when a workspace's agent is ready, a new one after a reconnect
   * included: its channel is subscribed then, not at its first PTY call.
   */
  onProviderReady?(listener: (workspaceId: string) => void): () => void;
}

export interface AgentPtyHostOptions {
  /**
   * The ids of the terminal tabs the app's windows keep for a workspace, as
   * last saved: the tabs that may yet attach to a session the agent runs,
   * as a restored tab does once its workspace first shows. A session of
   * none of them, and of no tab live here, is one no tab will reach again,
   * and is killed. Absent, such sessions are left to the agent.
   */
  readonly knownTerminalTabs?: (workspaceId: string) => ReadonlySet<string>;
}

/**
 * Creates the main-process PTY host that relays terminal RPCs and events
 * through the workspace-scoped Go agent channel.
 */
export function startAgentPtyHost(
  workspaceManager: AgentPtyWorkspaceManager,
  options: AgentPtyHostOptions = {},
): PtyHostHandle {
  return new AgentPtyHostHandle(workspaceManager, options);
}

/**
 * AgentPtyHostHandle owns only main-side PTY session bookkeeping; the
 * underlying AgentChannel lifecycle remains owned by WorkspaceManager.
 */
class AgentPtyHostHandle implements PtyHostHandle {
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private readonly sessions = new Map<string, AgentPtySession>();
  private readonly sessionsByWorkspace = new Map<string, Set<string>>();
  private readonly subscriptions = new Map<string, WorkspaceSubscription>();
  /**
   * Tracks workspaces whose PTY sessions are currently on hold during a
   * reconnect window. Sessions in this set receive `pty.held` instead of
   * `pty.exit` so the renderer shows a "reconnecting" indicator rather than
   * a dead-terminal banner.
   */
  private readonly heldWorkspaces = new Set<string>();
  /**
   * Tabs, by workspace, whose session the agent may still run though no tab
   * wants it: closed, or shown as ended by an exit main reported for a link
   * that failed while the daemon kept running. Each is killed whenever the
   * agent is reached, until it answers that the session is gone. A kill
   * sent once is not enough: one on a dying link is lost, and the daemon
   * keeps every session while a dialer is attached.
   */
  private readonly unwanted = new Map<string, Set<string>>();
  /**
   * The last pty.spawn or pty.kill of each tab, by session key. A tab's next
   * one is sent once it settles: the agent handles each request on its own
   * goroutine, so a kill sent right after the spawn (both waiting out a
   * reconnect, then flushed together) can run first, find nothing, and
   * leave the shell running with no tab.
   */
  private readonly tabOps = new Map<string, Promise<unknown>>();
  /** Session keys whose spawn is requested and not yet answered. */
  private readonly spawning = new Set<string>();
  /**
   * Session keys whose session was killed to bring the agent's sessions in
   * line, and whose exit is awaited, with what resolves the wait.
   */
  private readonly exitWaiters = new Map<string, () => void>();
  private disposed = false;
  private readonly disposeProviderReady: () => void;

  constructor(
    private readonly workspaceManager: AgentPtyWorkspaceManager,
    private readonly options: AgentPtyHostOptions = {},
  ) {
    // An agent tells Claude Code hooks and `nexus` commands whether or not a
    // terminal of its workspace ran yet: a Claude tab's hooks, or any after
    // a reconnect to a new agent, whose terminals are gone. Its channel is
    // subscribed once it is ready, so they are relayed (and answered) at once.
    // A new connection may reach a daemon that kept running sessions no tab
    // wants (closed while the link was down, or shown as ended): they are
    // killed then.
    this.disposeProviderReady =
      workspaceManager.onProviderReady?.((workspaceId) => {
        if (this.disposed) return;
        void this.tryChannelForWorkspace(workspaceId)
          .then((channel) => {
            // Held tabs are restored, and the rest synced with them, once
            // re-authentication resolves the hold (restoreAfterReauth).
            if (!channel || this.disposed || this.heldWorkspaces.has(workspaceId)) return;
            return this.syncSessions(workspaceId, channel, new Set());
          })
          .catch((err: unknown) => {
            log.warn(`subscribe failed for ${workspaceId}: ${(err as Error).message}`);
          });
      }) ?? (() => {});
  }

  async call(method: string, args: unknown): Promise<unknown> {
    if (this.disposed) {
      // Shutdown race: the renderer's xterm ResizeObserver (and similar
      // fire-and-forget paths) can still dispatch pty IPC after dispose()
      // runs at quit. The renderer already ignores rejections for
      // write/resize/kill/ack, so silently no-op those to avoid noisy
      // "Error occurred in handler for 'ipc:call'" logs at shutdown. spawn
      // returns a typed { pid } that callers depend on, so keep its throw.
      if (method === "spawn") {
        throw new Error("PTY agent host disposed");
      }
      return undefined;
    }

    const { workspaceId, tabId } = workspaceTabFromArgs(args, method);

    if (method === "spawn") return this.spawn(args, workspaceId, tabId);
    if (method === "kill") return this.kill(workspaceId, tabId);

    // For spawn we need the channel or it's a hard error; for the other
    // methods (write/resize/ack, and kill above) a missing workspace is a
    // normal racing condition — the workspace was removed before the
    // renderer-side fire-and-forget IPC arrived.  Use tryChannelForWorkspace so those
    // paths return undefined instead of propagating a "workspace not found"
    // throw that Electron would log as an unhandled handler error.
    const channel = await this.tryChannelForWorkspace(workspaceId);
    if (!channel) return undefined;

    // write is silently dropped when the session is held — the renderer
    // should show an inline "input not sent during reconnect" hint, so no
    // queuing is needed here.
    if (method === "write" && this.heldWorkspaces.has(workspaceId)) {
      return undefined;
    }

    switch (method) {
      case "write":
        return channel.call("pty.write", args);
      case "resize":
        return channel.call("pty.resize", args);
      case "ack":
        return channel.call("pty.ack", ackParamsFromArgs(args, workspaceId, tabId));
      case "foregroundProcess":
        return channel.call("pty.foregroundProcess", args);
      default:
        throw new Error(`agentPtyHost.call: unknown method: ${method}`);
    }
  }

  on(event: string, cb: EventCallback): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(cb);
    return () => listeners?.delete(cb);
  }

  isAlive(): boolean {
    return !this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeProviderReady();
    // Emit pty.exit for every active session before tearing down, so renderers
    // can enter a dead state rather than waiting indefinitely.
    const activeSessions = Array.from(this.sessions.values());
    for (const session of activeSessions) {
      this.emitExit(session.workspaceId, session.tabId, null);
    }
    for (const subscription of this.subscriptions.values()) {
      for (const dispose of subscription.disposers) dispose();
    }
    this.subscriptions.clear();
    this.sessions.clear();
    this.sessionsByWorkspace.clear();
    this.heldWorkspaces.clear();
    this.unwanted.clear();
    for (const resolve of this.exitWaiters.values()) resolve();
    this.exitWaiters.clear();
    this.listeners.clear();
  }

  /**
   * Registers the session before pty.spawn so early agent data frames can be
   * decoded even if they arrive before the spawn RPC response.
   *
   * The agent attaches instead of spawning when the tab's session is still
   * running — the app restarted, or its window reloaded, while the agent kept
   * the session alive. The new terminal is blank, so the session is replayed
   * to redraw it.
   *
   * The spawn follows the tab's kill in flight, if any, and a kill asked for
   * meanwhile follows it.
   *
   * A spawn that fails leaves the tab unwanted if it was (the agent may
   * still run its old session) or if pty.spawn was sent (the agent may have
   * started it all the same).
   */
  private spawn(
    args: unknown,
    workspaceId: string,
    tabId: string,
  ): Promise<{ pid: number; attached?: boolean }> {
    const key = sessionKey(workspaceId, tabId);
    const wasUnwanted = this.isUnwanted(workspaceId, tabId);
    // Opened again (Reopen on an ended tab): its session is wanted.
    this.settleUnwanted(workspaceId, tabId);
    this.spawning.add(key);
    let sent = false;
    const run = this.runTabOp(key, async () => {
      // Closed before its turn came: start nothing.
      if (this.isUnwanted(workspaceId, tabId)) {
        throw new Error("terminal closed before it started");
      }
      const channel = await this.channelForWorkspace(workspaceId);
      if (this.isUnwanted(workspaceId, tabId)) {
        throw new Error("terminal closed before it started");
      }
      const spawn = args as { env?: Record<string, string> };
      const env = spawn.env;
      const hooks =
        env?.NEXUS_WRAPPER_SELF_DIR && this.workspaceManager.getSpawnHookInfo
          ? await this.workspaceManager.getSpawnHookInfo(workspaceId, channel)
          : null;
      // The tab can also close while the replacement's hooks are being read.
      if (this.isUnwanted(workspaceId, tabId)) {
        throw new Error("terminal closed before it started");
      }
      this.rememberSession(workspaceId, tabId);
      let result: AgentSpawnResult;
      try {
        sent = true;
        result = await channel.call<AgentSpawnResult>(
          "pty.spawn",
          hooks
            ? {
                ...spawn,
                env: {
                  ...env,
                  NEXUS_AGENT_SOCKET: hooks.socketPath,
                  NEXUS_HOOK_TOKEN: tabHookToken(hooks, workspaceId, tabId),
                },
              }
            : args,
        );
      } catch (error) {
        this.deleteSession(workspaceId, tabId);
        throw error;
      }
      // A tab closed while it started has no terminal to redraw.
      if (result.attached && this.sessions.has(key)) {
        channel.call("pty.replay", { workspaceId, tabId }).catch((err) => {
          log.warn(`pty.replay failed for ${workspaceId}:${tabId}: ${(err as Error).message}`);
        });
      }
      return result.attached ? { pid: result.pid, attached: true } : { pid: result.pid };
    });
    void run.then(
      () => this.spawning.delete(key),
      () => {
        this.spawning.delete(key);
        if (wasUnwanted || sent) this.markUnwanted(workspaceId, tabId);
      },
    );
    return run;
  }

  /**
   * Kills a closed tab's session. The tab is the renderer's no longer from
   * now on: its session is dropped here, so an outage does not hold it and
   * a reattach does not replay it, and it stays unwanted until the agent
   * has killed it — a kill that fails is sent again once the agent is
   * reached. Never rejects: there is no tab left to tell.
   */
  private async kill(workspaceId: string, tabId: string): Promise<undefined> {
    this.markUnwanted(workspaceId, tabId);
    this.deleteSession(workspaceId, tabId);
    await this.runTabOp(sessionKey(workspaceId, tabId), () =>
      this.sendKill(workspaceId, tabId, () => this.tryChannelForWorkspace(workspaceId)),
    );
    return undefined;
  }

  /**
   * Sends one pty.kill for an unwanted tab, through the channel `getChannel`
   * gives. Its success settles the tab, as does a workspace that is gone;
   * its failure leaves it unwanted. Resolves whether the agent killed it.
   */
  private async sendKill(
    workspaceId: string,
    tabId: string,
    getChannel: () => Promise<AgentChannel | null>,
  ): Promise<boolean> {
    try {
      const channel = await getChannel();
      if (!channel) {
        this.settleUnwanted(workspaceId, tabId);
        return false;
      }
      await channel.call("pty.kill", { workspaceId, tabId });
      this.settleUnwanted(workspaceId, tabId);
      return true;
    } catch (err) {
      log.warn(
        `pty.kill failed for ${workspaceId}:${tabId}; sent again once the agent is reached: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Kills a session the agent listed and no tab wants, and waits (a while)
   * for its exit: a Reopen of its tab asked for meanwhile spawns after it,
   * and gets a new session rather than the dying one.
   */
  private async killListedSession(
    workspaceId: string,
    tabId: string,
    channel: AgentChannel,
  ): Promise<void> {
    const key = sessionKey(workspaceId, tabId);
    let timer: NodeJS.Timeout | undefined;
    const exited = new Promise<void>((resolve) => {
      this.exitWaiters.set(key, resolve);
      timer = setTimeout(resolve, KILL_EXIT_WAIT_MS);
    });
    try {
      if (await this.sendKill(workspaceId, tabId, async () => channel)) await exited;
    } finally {
      clearTimeout(timer);
      this.exitWaiters.delete(key);
    }
  }

  /**
   * Runs `op` once the tab's previous spawn or kill has settled, so the
   * agent gets a tab's spawns and kills in the order they were asked for.
   */
  private runTabOp<T>(key: string, op: () => Promise<T>): Promise<T> {
    const previous = this.tabOps.get(key) ?? Promise.resolve();
    const run = previous.then(op, op);
    const settled = run.then(
      () => {},
      () => {},
    );
    this.tabOps.set(key, settled);
    void settled.then(() => {
      if (this.tabOps.get(key) === settled) this.tabOps.delete(key);
    });
    return run;
  }

  private isUnwanted(workspaceId: string, tabId: string): boolean {
    return this.unwanted.get(workspaceId)?.has(tabId) === true;
  }

  /** Notes that no tab wants the session the agent may run for `tabId`. */
  private markUnwanted(workspaceId: string, tabId: string): void {
    let tabIds = this.unwanted.get(workspaceId);
    if (!tabIds) {
      tabIds = new Set();
      this.unwanted.set(workspaceId, tabIds);
    }
    tabIds.add(tabId);
  }

  /** The agent runs no session for `tabId` any more. */
  private settleUnwanted(workspaceId: string, tabId: string): void {
    const tabIds = this.unwanted.get(workspaceId);
    if (!tabIds) return;
    tabIds.delete(tabId);
    if (tabIds.size === 0) this.unwanted.delete(workspaceId);
  }

  /**
   * Ends a tab's session for the renderer, which shows it as ended, without
   * the agent having said so: the daemon may still run it, and is told to
   * kill it once it is reached.
   */
  private endSession(workspaceId: string, tabId: string): void {
    this.markUnwanted(workspaceId, tabId);
    this.emitExit(workspaceId, tabId, null);
  }

  hasWorkspaceSessions(workspaceId: string): boolean {
    if (this.sessionsByWorkspace.get(workspaceId)?.size) return true;
    const prefix = sessionKey(workspaceId, "");
    return [...this.spawning].some((key) => key.startsWith(prefix));
  }

  /**
   * Terminates all active PTY sessions for the given workspace by emitting
   * pty.exit events. Called from `WorkspaceManager.remove()` *before* the
   * workspace context is deleted — this guarantees the renderer sees the
   * session deaths as a main-initiated event rather than discovering them
   * via a failed post-removal IPC round-trip.
   */
  closeWorkspaceSessions(workspaceId: string): void {
    const tabIds = Array.from(this.sessionsByWorkspace.get(workspaceId) ?? []);
    for (const tabId of tabIds) {
      this.emitExit(workspaceId, tabId, null);
    }
    this.heldWorkspaces.delete(workspaceId);
    // The workspace's agent is asked to exit, and its terminals with it.
    this.unwanted.delete(workspaceId);
    // Clean up the channel subscription so no further agent events arrive
    // for this workspace after the context is gone.
    const subscription = this.subscriptions.get(workspaceId);
    if (subscription) {
      for (const dispose of subscription.disposers) dispose();
      this.subscriptions.delete(workspaceId);
    }
  }

  /**
   * Called by manager after successful re-authentication. Acquires the new
   * channel via `tryGetAgentChannel`, subscribes its lifecycle, then runs
   * the session.list reconcile path to replay alive tabs and exit dead tabs.
   */
  async restoreAfterReauth(workspaceId: string): Promise<void> {
    const channel = await this.workspaceManager.tryGetAgentChannel(workspaceId);
    if (!channel) {
      // Workspace was removed while reauth was in progress — release held
      // sessions so they don't leak.
      this.releaseHeld(workspaceId);
      return;
    }
    await channel.ready;
    // Subscribe to the new channel so lifecycle events are wired up.
    this.subscribeWorkspace(workspaceId, channel);
    // Only proceed if sessions are still held — a concurrent releaseHeld or
    // closeWorkspaceSessions call could have cleared the hold. The new
    // provider's ready (constructor) syncs the sessions then.
    if (!this.heldWorkspaces.has(workspaceId)) return;
    this.heldWorkspaces.delete(workspaceId);
    await this.syncSessions(workspaceId, channel, this.liveTabIds(workspaceId));
  }

  /**
   * Releases held sessions on every non-reauth terminal exit path (auth
   * cancelled, backoff exhausted, non-interactive failure, ctx gone).
   * Emits `pty.expired` then `pty.exit` for each held tab. No-op when no
   * hold is active for the workspace. The daemon may well outlive the
   * link and run them still: they are killed once it is reached again.
   */
  releaseHeld(workspaceId: string): void {
    if (!this.heldWorkspaces.has(workspaceId)) return;
    this.heldWorkspaces.delete(workspaceId);
    for (const tabId of this.liveTabIds(workspaceId)) {
      this.emit("expired", { workspaceId, tabId });
      this.endSession(workspaceId, tabId);
    }
  }

  /**
   * Gets and subscribes the workspace channel before any PTY RPC uses it.
   * Throws when the workspace is not found.
   */
  private async channelForWorkspace(workspaceId: string): Promise<AgentChannel> {
    const channel = await this.workspaceManager.getAgentChannel(workspaceId);
    await channel.ready;
    this.subscribeWorkspace(workspaceId, channel);
    return channel;
  }

  /**
   * Like `channelForWorkspace` but returns `null` instead of throwing when
   * the workspace is not found. Used by write/resize/ack/kill where a missing
   * workspace is a normal racing condition (removal won the race).
   */
  private async tryChannelForWorkspace(workspaceId: string): Promise<AgentChannel | null> {
    const channel = await this.workspaceManager.tryGetAgentChannel(workspaceId);
    if (!channel) return null;
    await channel.ready;
    this.subscribeWorkspace(workspaceId, channel);
    return channel;
  }

  /**
   * Wires agent push events into the host-level event emitter once per
   * workspace channel.
   */
  private subscribeWorkspace(workspaceId: string, channel: AgentChannel): void {
    const existing = this.subscriptions.get(workspaceId);
    if (existing?.channel === channel) {
      return;
    }
    if (existing) {
      for (const dispose of existing.disposers) dispose();
    }

    const offData = channel.on("pty.data", (payload) => this.handleData(payload));
    const offExit = channel.on("pty.exit", (payload) => this.handleExit(payload));
    // Relays claude.hook events to the PtyHostHandle.on subscribers.
    // A hook speaks only for the workspace whose agent it arrived through.
    // On an SSH host the hook server is reachable by anything running there,
    // which must not be able to set another workspace's status, raise
    // notifications in its name, or route a hook response to its channel.
    const offClaudeHook = channel.on("claude.hook", (payload) => {
      const claimed = (payload as { workspaceId?: unknown } | null)?.workspaceId;
      if (claimed !== workspaceId) {
        log.warn(
          `Dropped claude.hook for workspace ${String(claimed)} from ${workspaceId}'s agent`,
        );
        return;
      }
      this.emit("claude.hook", payload);
    });
    // A held hook whose client went away, on the same terms.
    const offClaudeHookGone = channel.on("claude.hookGone", (payload) => {
      const claimed = (payload as { workspaceId?: unknown } | null)?.workspaceId;
      if (claimed !== workspaceId) {
        log.warn(
          `Dropped claude.hookGone for workspace ${String(claimed)} from ${workspaceId}'s agent`,
        );
        return;
      }
      this.emit("claude.hookGone", payload);
    });
    // The nexus CLI speaks for its terminal's workspace on the same terms.
    const offCliRequest = channel.on("cli.request", (payload) => {
      const claimed = (payload as { workspaceId?: unknown } | null)?.workspaceId;
      if (claimed !== workspaceId) {
        log.warn(
          `Dropped cli.request for workspace ${String(claimed)} from ${workspaceId}'s agent`,
        );
        return;
      }
      this.emit("cli.request", payload);
    });
    const offCliCancel = channel.on("cli.cancel", (payload) => {
      const claimed = (payload as { workspaceId?: unknown } | null)?.workspaceId;
      if (claimed !== workspaceId) {
        log.warn(`Dropped cli.cancel for workspace ${String(claimed)} from ${workspaceId}'s agent`);
        return;
      }
      this.emit("cli.cancel", payload);
    });
    const offLifecycle = channel.onLifecycle((event) => {
      this.handleLifecycle(workspaceId, event);
    });
    this.subscriptions.set(workspaceId, {
      channel,
      disposers: [
        offData,
        offExit,
        offClaudeHook,
        offClaudeHookGone,
        offCliRequest,
        offCliCancel,
        offLifecycle,
      ],
    });
  }

  /**
   * Decodes one base64 PTY byte chunk through the session's streaming decoder.
   */
  private handleData(payload: unknown): void {
    const parsed = parseAgentDataPayload(payload);
    if (!parsed) return;

    const session = this.sessions.get(sessionKey(parsed.workspaceId, parsed.tabId));
    if (!session) return;

    const chunk = session.decoder.decode(Buffer.from(parsed.chunk, "base64"), { stream: true });
    if (chunk.length > 0) {
      this.emit("data", {
        workspaceId: parsed.workspaceId,
        tabId: parsed.tabId,
        chunk,
        ...(parsed.replay ? { replay: true } : {}),
      });
    }
  }

  /**
   * Flushes any trailing decoder bytes before forwarding the child exit.
   */
  private handleExit(payload: unknown): void {
    const parsed = parseAgentExitPayload(payload);
    if (!parsed) return;
    const key = sessionKey(parsed.workspaceId, parsed.tabId);
    // The agent no longer runs it, killed or ended on its own.
    this.settleUnwanted(parsed.workspaceId, parsed.tabId);
    const waiter = this.exitWaiters.get(key);
    if (waiter) {
      waiter();
      // The exit of a session killed while its tab, shown as ended already,
      // starts a new one: told, the tab would show its new terminal ended.
      if (this.spawning.has(key) && !this.sessions.has(key)) return;
    }
    this.emitExit(parsed.workspaceId, parsed.tabId, parsed.code);
  }

  /**
   * Converts terminal channel lifecycle events into PTY session signals.
   *
   * Reattach model (epoch-aware):
   *   - `reconnecting`: sessions are placed on hold instead of being killed.
   *     The renderer is notified via `pty.held` so it can show a "reconnecting"
   *     indicator without displaying the dead-terminal banner.
   *   - `ready` (epoch-match restore): the daemon survived the outage.
   *     session.list is called to discover which sessions are still alive, then
   *     pty.replay is requested for each alive tab. Dead tabs receive pty.exit.
   *     Sessions no tab wants (closed during the outage, their kill lost)
   *     are killed.
   *   - `held-then-expired`: the daemon was replaced. Held sessions are
   *     expired via `pty.expired` (renderer shows "session expired" empty
   *     state) and then released via `pty.exit`.
   *   - `failure` / `exit`: if sessions were held, emit pty.exit for them
   *     (the reconnect window ended without recovery). Otherwise normal exit.
   *   - `degraded` / `degraded-recovered`: forwarded to consumers via the
   *     "degraded" / "degraded-recovered" host events (manager reacts).
   *   - `disposed`: local host teardown only — no session-death signals here
   *     because `dispose()` handles that path.
   *
   * Legacy / local channel behaviour is preserved: when no epoch was ever
   * seen (legacy agent) the `reconnecting` event still kills PTY sessions
   * immediately (current behaviour), because there is no daemon to reattach
   * to.
   */
  private handleLifecycle(workspaceId: string, event: ChannelLifecycleEvent): void {
    if (event.type === "degraded") {
      this.emit("degraded", { workspaceId });
      return;
    }

    if (event.type === "degraded-recovered") {
      this.emit("degraded-recovered", { workspaceId });
      return;
    }

    if (event.type === "reconnecting") {
      if (event.hadEpoch) {
        // Epoch-aware daemon: hold sessions so they can be restored after
        // a successful reattach. The renderer is notified via pty.held so
        // it shows a "reconnecting" indicator without a dead-terminal banner.
        const tabIds = Array.from(this.sessionsByWorkspace.get(workspaceId) ?? []);
        if (tabIds.length > 0) {
          this.heldWorkspaces.add(workspaceId);
          for (const tabId of tabIds) {
            this.emit("held", { workspaceId, tabId });
          }
        }
      } else {
        // Legacy / local path: no daemon to survive the outage, kill sessions
        // immediately so the renderer shows the dead-terminal banner.
        const tabIds = Array.from(this.sessionsByWorkspace.get(workspaceId) ?? []);
        for (const tabId of tabIds) {
          this.emitExit(workspaceId, tabId, null);
        }
        const sub = this.subscriptions.get(workspaceId);
        if (sub) {
          for (const dispose of sub.disposers) dispose();
          this.subscriptions.delete(workspaceId);
        }
      }
      return;
    }

    if (event.type === "ready") {
      // Epoch-match reattach: restore held sessions, and kill those no tab
      // wants — held or not, the daemon ran all of them through the outage.
      const held = this.heldWorkspaces.has(workspaceId)
        ? this.liveTabIds(workspaceId)
        : new Set<string>();
      this.heldWorkspaces.delete(workspaceId);
      const subscription = this.subscriptions.get(workspaceId);
      if (subscription) {
        void this.syncSessions(workspaceId, subscription.channel, held);
      }
      return;
    }

    if (event.type === "held-then-expired") {
      // Daemon was replaced: expire all held sessions.
      if (this.heldWorkspaces.has(workspaceId)) {
        this.heldWorkspaces.delete(workspaceId);
        const tabIds = Array.from(this.sessionsByWorkspace.get(workspaceId) ?? []);
        for (const tabId of tabIds) {
          this.emit("expired", { workspaceId, tabId });
          this.emitExit(workspaceId, tabId, null);
        }
      }
      // Emit degraded broadcast so manager can broadcast held-then-expired status.
      this.emit("held-then-expired", { workspaceId });
      const sub = this.subscriptions.get(workspaceId);
      if (sub) {
        for (const dispose of sub.disposers) dispose();
        this.subscriptions.delete(workspaceId);
      }
      return;
    }

    if (event.type === "failure" || event.type === "exit") {
      // Unsubscribe from the dead channel unconditionally — it will never
      // send useful events again.
      const subscription = this.subscriptions.get(workspaceId);
      if (subscription) {
        for (const dispose of subscription.disposers) dispose();
        this.subscriptions.delete(workspaceId);
      }

      if (this.heldWorkspaces.has(workspaceId)) {
        // Sessions are held — manager owns the decision about what happens
        // next (re-authenticate or release). Do NOT emit exits here; the
        // renderer already shows a "reconnecting" indicator via pty.held.
        // manager will call restoreAfterReauth() on success or
        // releaseHeld() on every non-reauth exit path.
        return;
      }

      // No hold: emit exits for all sessions on the normal path. A daemon
      // may outlive the link and still run them.
      for (const tabId of this.liveTabIds(workspaceId)) {
        this.endSession(workspaceId, tabId);
      }
    }
  }

  /**
   * Brings the workspace's sessions in line with the daemon `channel`
   * reaches, after an outage or on a new connection: queries the agent for
   * the sessions it runs, replays each `held` tab that is still alive and
   * exits the others, and kills every session no tab wants.
   */
  private async syncSessions(
    workspaceId: string,
    channel: AgentChannel,
    held: ReadonlySet<string>,
  ): Promise<void> {
    let aliveTabs: Set<string>;
    try {
      const result = await channel.call<{
        sessions: Array<{ workspaceId: string; tabId: string }>;
      }>("session.list", { workspaceId });
      aliveTabs = new Set(
        (result.sessions ?? []).filter((s) => s.workspaceId === workspaceId).map((s) => s.tabId),
      );
    } catch (err) {
      const message = (err as Error).message;
      if (held.size === 0) {
        log.warn(
          `session.list failed for workspace ${workspaceId}; sessions no tab wants are killed once it answers: ${message}`,
        );
        return;
      }
      // The link dropped again under it: the new hold has the held tabs.
      if (this.heldWorkspaces.has(workspaceId)) {
        log.warn(
          `session.list failed for workspace ${workspaceId} after reattach; tabs held again: ${message}`,
        );
        return;
      }
      log.warn(
        `session.list failed for workspace ${workspaceId} after reattach; ending held sessions: ${message}`,
      );
      // The tabs show their sessions ended. The agent may well run them
      // still, but no answer of it says so: one a tab reopens is attached
      // to, not killed.
      for (const tabId of held) {
        if (!this.sessions.has(sessionKey(workspaceId, tabId))) continue;
        this.emit("expired", { workspaceId, tabId });
        this.emitExit(workspaceId, tabId, null);
      }
      return;
    }

    this.restoreHeldSessions(workspaceId, channel, held, aliveTabs);
    this.killUnwantedSessions(workspaceId, channel, aliveTabs);
  }

  /**
   * After an epoch-match reattach, replays each held tab that is still
   * alive. Tabs no longer present in session.list receive pty.exit. A held
   * tab closed meanwhile is left to the kill. One whose spawn waited out
   * the outage is left to that spawn, which the agent may answer after the
   * list.
   */
  private restoreHeldSessions(
    workspaceId: string,
    channel: AgentChannel,
    heldTabIds: ReadonlySet<string>,
    aliveTabs: ReadonlySet<string>,
  ): void {
    for (const tabId of heldTabIds) {
      const key = sessionKey(workspaceId, tabId);
      if (!this.sessions.has(key)) continue;
      if (this.spawning.has(key)) {
        this.emit("restored", { workspaceId, tabId, withReplay: false });
        continue;
      }
      if (aliveTabs.has(tabId)) {
        // Session is alive on the daemon: inject \x1bc into the data stream
        // BEFORE emitting restored and requesting replay. Because reset and
        // replay travel on the same stream, this guarantees the ordering:
        //   reset → restored (IPC control) → replay data → wiggle repaint
        // A control-channel reset (writeReset in the renderer) races with the
        // data stream and can arrive AFTER replay data, wiping the repaint.
        // The replay leads with its own reset; this one covers daemons that
        // predate it and replay only the output produced during the outage.
        this.emit("data", { workspaceId, tabId, chunk: "\x1bc" });
        this.emit("restored", { workspaceId, tabId, withReplay: true });
        // Reset the session's decoder so replay bytes decode cleanly.
        const session = this.sessions.get(key);
        if (session) {
          session.decoder = new TextDecoder("utf-8");
        }
        // pty.replay resends the session's recent output as pty.data events.
        // Its answer follows them on the same stream, so "replayed" comes
        // after the last replayed chunk.
        channel
          .call("pty.replay", { workspaceId, tabId })
          .then(() => this.emit("replayed", { workspaceId, tabId }))
          .catch((err) => {
            log.warn(`pty.replay failed for ${workspaceId}:${tabId}: ${(err as Error).message}`);
          });
      } else {
        // Session no longer alive on the daemon — treat as a fresh shell.
        // Inject \x1bc into the data stream so any stale ANSI mid-sequence
        // garbage accumulated before the hold is cleared before the renderer
        // shows the new prompt, consistent with the alive-tab path.
        this.emit("data", { workspaceId, tabId, chunk: "\x1bc" });
        this.emit("restored", { workspaceId, tabId, withReplay: false });
        this.emitExit(workspaceId, tabId, null);
      }
    }
  }

  /**
   * Kills each of the workspace's sessions in `aliveTabs` (the agent's
   * session.list) that no tab wants: one whose tab was closed or shown as
   * ended, or, with `knownTerminalTabs`, one of no tab the app keeps. A
   * session of a tab live here, or starting, is the tab's. Unwanted tabs
   * the agent no longer runs are settled.
   */
  private killUnwantedSessions(
    workspaceId: string,
    channel: AgentChannel,
    aliveTabs: ReadonlySet<string>,
  ): void {
    for (const tabId of Array.from(this.unwanted.get(workspaceId) ?? [])) {
      if (!aliveTabs.has(tabId)) this.settleUnwanted(workspaceId, tabId);
    }
    const known = this.options.knownTerminalTabs?.(workspaceId);
    for (const tabId of aliveTabs) {
      const key = sessionKey(workspaceId, tabId);
      if (this.sessions.has(key) || this.spawning.has(key)) continue;
      const tabless = known !== undefined && !known.has(tabId);
      if (!tabless && !this.isUnwanted(workspaceId, tabId)) continue;
      log.info(`killing ${workspaceId}:${tabId}, a session no tab wants`);
      this.markUnwanted(workspaceId, tabId);
      void this.runTabOp(key, () => this.killListedSession(workspaceId, tabId, channel));
    }
  }

  /** The workspace's tabs whose session is live here (held ones included). */
  private liveTabIds(workspaceId: string): Set<string> {
    return new Set(this.sessionsByWorkspace.get(workspaceId) ?? []);
  }

  /**
   * Records one agent-backed PTY session and its UTF-8 streaming decoder.
   */
  private rememberSession(workspaceId: string, tabId: string): void {
    const key = sessionKey(workspaceId, tabId);
    if (!this.sessions.has(key)) {
      this.sessions.set(key, {
        workspaceId,
        tabId,
        decoder: new TextDecoder("utf-8"),
      });
    }

    let tabIds = this.sessionsByWorkspace.get(workspaceId);
    if (!tabIds) {
      tabIds = new Set();
      this.sessionsByWorkspace.set(workspaceId, tabIds);
    }
    tabIds.add(tabId);
  }

  /**
   * Emits a pty.exit and removes session state after flushing decoder tail.
   */
  private emitExit(workspaceId: string, tabId: string, code: number | null): void {
    const session = this.sessions.get(sessionKey(workspaceId, tabId));
    if (session) {
      const tail = session.decoder.decode();
      if (tail.length > 0) {
        this.emit("data", { workspaceId, tabId, chunk: tail });
      }
    }
    this.deleteSession(workspaceId, tabId);
    this.emit("exit", { workspaceId, tabId, code });
  }

  /**
   * Removes one session without emitting a renderer-visible lifecycle event.
   */
  private deleteSession(workspaceId: string, tabId: string): void {
    this.sessions.delete(sessionKey(workspaceId, tabId));
    const tabIds = this.sessionsByWorkspace.get(workspaceId);
    if (!tabIds) return;
    tabIds.delete(tabId);
    if (tabIds.size === 0) {
      this.sessionsByWorkspace.delete(workspaceId);
    }
  }

  /**
   * Emits one host-level event to registered IPC bridge listeners.
   */
  private emit(event: string, args: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb(args);
    }
  }
}

/**
 * Builds the stable key used for session and route maps.
 */
function sessionKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}

/**
 * Extracts the required workspace/tab identity from already-validated IPC args.
 */
function workspaceTabFromArgs(
  args: unknown,
  method: string,
): { workspaceId: string; tabId: string } {
  const record = asRecord(args);
  if (typeof record?.workspaceId !== "string" || typeof record.tabId !== "string") {
    throw new Error(`pty.${method} params must include workspaceId and tabId`);
  }
  return { workspaceId: record.workspaceId, tabId: record.tabId };
}

/**
 * Builds the exact pty.ack payload expected by the Go agent service.
 */
function ackParamsFromArgs(
  args: unknown,
  workspaceId: string,
  tabId: string,
): { workspaceId: string; tabId: string; bytesConsumed: number } {
  const record = asRecord(args);
  if (typeof record?.bytesConsumed !== "number") {
    throw new Error("pty.ack params must include bytesConsumed");
  }
  return { workspaceId, tabId, bytesConsumed: record.bytesConsumed };
}

/**
 * Narrows unknown values to object records.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parses a pty.data event emitted by the Go agent.
 */
function parseAgentDataPayload(
  payload: unknown,
): { workspaceId: string; tabId: string; chunk: string; replay: boolean } | null {
  const record = asRecord(payload);
  if (
    typeof record?.workspaceId !== "string" ||
    typeof record.tabId !== "string" ||
    typeof record.chunk !== "string"
  ) {
    return null;
  }
  return {
    workspaceId: record.workspaceId,
    tabId: record.tabId,
    chunk: record.chunk,
    replay: record.replay === true,
  };
}

/**
 * Parses a pty.exit event emitted by the Go agent.
 */
function parseAgentExitPayload(
  payload: unknown,
): { workspaceId: string; tabId: string; code: number | null } | null {
  const record = asRecord(payload);
  if (typeof record?.workspaceId !== "string" || typeof record.tabId !== "string") {
    return null;
  }
  const code = typeof record.code === "number" ? record.code : null;
  return { workspaceId: record.workspaceId, tabId: record.tabId, code };
}
