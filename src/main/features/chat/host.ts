// Main-process side of the Claude tabs: starts each tab's program through
// the workspace's agent and relays its chat.* events to the renderer.

import {
  type AgentProfile,
  PROFILE_DIR_ENV,
  SHAREABLE,
} from "../../../shared/agent-profiles/profiles";
import { createLogger } from "../../../shared/log/main";
import { isManagerWorkspace } from "../../../shared/manager/manager";
import type { AgentChannel, ChannelLifecycleEvent } from "../../infra/agent/channel";
import type { WindowsAgentFiles } from "../pty/windows-shell-shim";
import type { HookInfo } from "../workspace/manager";
import { tabHookToken } from "../workspace/tab-token";
import {
  type ClaudeCommand,
  claudeCommandArgs,
  claudeTabArgs,
  claudeTabEnv,
  codexTabEnv,
  hostJoin,
  parseClaudeVersion,
  type ResumeOptions,
} from "./launch";

const log = createLogger("chat-host");

/** How long `claude --version` may take: a first run can unpack itself. */
const VERSION_TIMEOUT_MS = 20_000;
/** How long a `claude` command may take: an install fetches the plugin. */
const COMMAND_TIMEOUT_MS = 30_000;

export interface ChatWorkspaceManager {
  getAgentChannel(workspaceId: string): Promise<AgentChannel>;
  tryGetAgentChannel(workspaceId: string): Promise<AgentChannel | null>;
  onProviderReady(listener: (workspaceId: string) => void): () => void;
  getHookInfo(workspaceId: string): HookInfo | null;
  getWrapperBinDir(workspaceId: string): string | null;
  getWrapperAgentBin(workspaceId: string): string | null;
  getWrapperShimDir(workspaceId: string): string | null;
  isLocal?(workspaceId: string): boolean;
}

export interface ChatHostOptions {
  workspaceManager: ChatWorkspaceManager;
  broadcast: (event: string, args: unknown) => void;
  /** On Windows, where local claude runs without the bash wrapper. */
  windowsAgentFiles?: () => Promise<WindowsAgentFiles | null>;
  /** A tab's turn ended short (interrupted, failed), which no hook tells. */
  onTurnStopped?: (workspaceId: string, tabId: string) => void;
  /** A tab's program exited. */
  onProgramExit?: (workspaceId: string, tabId: string) => void;
  /** The agent profile of that id, as the app state has it; null when gone. */
  profile?: (id: string) => AgentProfile | null;
}

export type StartResult =
  | { ok: true; pid: number; attached: boolean; version: string | null }
  | { ok: false; reason: "not-found" | "failed"; message: string };

interface Subscription {
  channel: AgentChannel;
  dispose: () => void;
}

export class ChatHost {
  private readonly subscriptions = new Map<string, Subscription>();
  /** Workspaces whose tabs have started a program through this host. */
  private readonly workspaces = new Set<string>();
  private readonly disposeProviderReady: () => void;
  private disposed = false;

  constructor(private readonly options: ChatHostOptions) {
    // A new agent (a reconnect that needed a new one, or a reauth) knows
    // nothing of this host's subscription; the tabs check what it has.
    this.disposeProviderReady = options.workspaceManager.onProviderReady((workspaceId) => {
      if (!this.workspaces.has(workspaceId)) return;
      void this.options.workspaceManager
        .tryGetAgentChannel(workspaceId)
        .then(async (channel) => {
          if (!channel) return;
          await channel.ready;
          this.subscribe(workspaceId, channel);
          this.options.broadcast("resync", { workspaceId });
        })
        .catch((err: unknown) => {
          log.warn(`resubscribe failed for ${workspaceId}: ${(err as Error).message}`);
        });
    });
  }

  async start(
    workspaceId: string,
    tabId: string,
    cwd: string,
    resume: ResumeOptions,
    profileId?: string,
  ): Promise<StartResult> {
    const channel = await this.channelFor(workspaceId);
    const { workspaceManager } = this.options;
    const windows =
      this.options.windowsAgentFiles !== undefined &&
      workspaceManager.isLocal?.(workspaceId) === true;

    const found = await channel.call<{ path: string; envPath?: string }>("lsp.findBinary", {
      name: "claude",
      dir: cwd,
    });
    if (!found.path) {
      return { ok: false, reason: "not-found", message: "claude was not found on the PATH" };
    }

    let version: string | null = null;
    try {
      const run = await channel.call<{ code: number; stdout: string }>("chat.exec", {
        cwd,
        program: found.path,
        args: ["--version"],
        env: found.envPath ? { PATH: found.envPath } : {},
        timeoutMs: VERSION_TIMEOUT_MS,
      });
      if (run.code === 0) version = parseClaudeVersion(run.stdout);
    } catch (err) {
      log.warn(`claude --version failed: ${(err as Error).message}`);
    }

    const hookInfo = workspaceManager.getHookInfo(workspaceId);
    const wrapperBinDir = workspaceManager.getWrapperBinDir(workspaceId);
    const agentBin = workspaceManager.getWrapperAgentBin(workspaceId);
    let program = found.path;
    let hooksSettings: string | undefined;
    let gitBash: { wrapperDir: string; bashEnv: string } | undefined;
    if (windows) {
      // cmd and PowerShell pass claude the hooks file the same way.
      const files = await this.options.windowsAgentFiles?.();
      hooksSettings = files?.settingsPath;
      const shimDir = workspaceManager.getWrapperShimDir(workspaceId);
      if (files && shimDir !== null) {
        gitBash = { wrapperDir: files.binDir, bashEnv: hostJoin(shimDir, "bashenv", true) };
      }
    } else if (wrapperBinDir !== null) {
      // The wrapper adds the hooks and the tab's mark, then runs the claude
      // the PATH has after it.
      program = hostJoin(wrapperBinDir, "claude", false);
    }
    const env = claudeTabEnv({
      workspaceId,
      tabId,
      path: found.envPath,
      wrapperBinDir,
      agentBin,
      agentSocket: hookInfo?.socketPath,
      hookToken: hookInfo ? tabHookToken(hookInfo, workspaceId, tabId) : undefined,
      withoutWrapper: windows,
      ...(gitBash ? { gitBash } : {}),
    });

    try {
      Object.assign(env, await this.profileEnv(channel, "claude", profileId));
      const result = await channel.call<{ pid: number; attached?: boolean }>("chat.start", {
        workspaceId,
        tabId,
        cwd,
        program,
        args: claudeTabArgs(resume, hooksSettings, isManagerWorkspace(workspaceId)),
        env,
        ...(resume.resetLog ? { resetLog: true } : {}),
        ...(resume.resume !== undefined ? { resumed: true } : {}),
      });
      return { ok: true, pid: result.pid, attached: result.attached === true, version };
    } catch (err) {
      return { ok: false, reason: "failed", message: (err as Error).message };
    }
  }

  /**
   * Runs a Codex tab's `codex app-server`, or attaches to the one the agent
   * still runs for it. The tab speaks its JSON-RPC over the same log. The
   * server runs with the tab's marks, as a Claude tab's claude does, so the
   * `claude -p` and `codex exec` runs its commands start are the tab's
   * agents; one the agent still runs keeps the environment it started with.
   */
  async startCodex(
    workspaceId: string,
    tabId: string,
    cwd: string,
    options: { resetLog?: boolean; profileId?: string },
  ): Promise<StartResult> {
    const channel = await this.channelFor(workspaceId);
    const found = await channel.call<{ path: string; envPath?: string }>("lsp.findBinary", {
      name: "codex",
      dir: cwd,
    });
    if (!found.path) {
      return { ok: false, reason: "not-found", message: "codex was not found on the PATH" };
    }
    let version: string | null = null;
    try {
      const run = await channel.call<{ code: number; stdout: string }>("chat.exec", {
        cwd,
        program: found.path,
        args: ["--version"],
        env: found.envPath ? { PATH: found.envPath } : {},
        timeoutMs: VERSION_TIMEOUT_MS,
      });
      if (run.code === 0) version = parseClaudeVersion(run.stdout);
    } catch (err) {
      log.warn(`codex --version failed: ${(err as Error).message}`);
    }
    const { workspaceManager } = this.options;
    const hookInfo = workspaceManager.getHookInfo(workspaceId);
    // Windows commands run in PowerShell or cmd, which read no shim files.
    const windows =
      this.options.windowsAgentFiles !== undefined &&
      workspaceManager.isLocal?.(workspaceId) === true;
    const env = codexTabEnv({
      workspaceId,
      tabId,
      path: found.envPath,
      wrapperBinDir: workspaceManager.getWrapperBinDir(workspaceId),
      agentBin: workspaceManager.getWrapperAgentBin(workspaceId),
      agentSocket: hookInfo?.socketPath,
      hookToken: hookInfo ? tabHookToken(hookInfo, workspaceId, tabId) : undefined,
      shimDir: windows ? null : workspaceManager.getWrapperShimDir(workspaceId),
    });
    try {
      Object.assign(env, await this.profileEnv(channel, "codex", options.profileId));
      const result = await channel.call<{ pid: number; attached?: boolean }>("chat.start", {
        workspaceId,
        tabId,
        cwd,
        program: found.path,
        args: ["app-server"],
        env,
        ...(options.resetLog ? { resetLog: true } : {}),
      });
      return { ok: true, pid: result.pid, attached: result.attached === true, version };
    } catch (err) {
      return { ok: false, reason: "failed", message: (err as Error).message };
    }
  }

  async call(
    method: "send" | "stop" | "close" | "replay" | "attach" | "pruneAttachments",
    args: unknown,
  ): Promise<unknown> {
    const workspaceId = (args as { workspaceId: string }).workspaceId;
    const channel =
      method === "close"
        ? await this.options.workspaceManager.tryGetAgentChannel(workspaceId)
        : await this.channelFor(workspaceId);
    if (!channel) return undefined;
    if (method !== "close") this.subscribe(workspaceId, channel);
    return channel.call(`chat.${method}`, args);
  }

  async transcript(workspaceId: string, sessionId: string, profileId?: string): Promise<unknown> {
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.transcript", { sessionId, ...this.configDir(profileId) });
  }

  async sessionFile(workspaceId: string, sessionId: string, profileId?: string): Promise<unknown> {
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.sessionFile", { sessionId, ...this.configDir(profileId) });
  }

  async stageThread(
    workspaceId: string,
    threadId: string,
    options: { fromProfileId?: string; toProfileId?: string },
  ): Promise<unknown> {
    const channel = await this.channelFor(workspaceId);
    const from = this.codexDir(options.fromProfileId);
    const to = this.codexDir(options.toProfileId);
    return channel.call("chat.stageThread", {
      threadId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }

  async claudeConfig(workspaceId: string, profileId?: string): Promise<unknown> {
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.claudeConfig", this.configDir(profileId));
  }

  /** Runs one of the `claude` commands a tab may (`claude agents`, `claude plugin`…) in the folder. */
  async cli(
    workspaceId: string,
    cwd: string,
    command: ClaudeCommand,
    profileId?: string,
  ): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
    const channel = await this.channelFor(workspaceId);
    const found = await channel.call<{ path: string; envPath?: string }>("lsp.findBinary", {
      name: "claude",
      dir: cwd,
    });
    if (!found.path) throw new Error("claude was not found on the PATH");
    return channel.call("chat.exec", {
      cwd,
      program: found.path,
      args: claudeCommandArgs(command, cwd),
      env: {
        ...(found.envPath ? { PATH: found.envPath } : {}),
        ...(await this.profileEnv(channel, "claude", profileId)),
      },
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
  }

  async sessions(workspaceId: string, cwd: string, profileId?: string): Promise<unknown> {
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.sessions", { cwd, ...this.configDir(profileId) });
  }

  async deleteSession(
    workspaceId: string,
    cwd: string,
    sessionId: string,
    profileId?: string,
  ): Promise<unknown> {
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.deleteSession", { cwd, sessionId, ...this.configDir(profileId) });
  }

  async fileSizes(workspaceId: string, paths: readonly string[]): Promise<unknown> {
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.fileSizes", { paths });
  }

  /** The Claude profile's folder, as the agent's readers take it; none for the default. */
  private configDir(profileId: string | undefined): { configDir?: string } {
    const profile = profileId ? this.options.profile?.(profileId) : null;
    if (!profile || profile.agent !== "claude" || profile.dir.trim() === "") return {};
    return { configDir: profile.dir.trim() };
  }

  /** A Codex profile's folder; "" for the default profile, or one gone. */
  private codexDir(profileId: string | undefined): string {
    const profile = profileId ? this.options.profile?.(profileId) : null;
    return profile?.agent === "codex" ? profile.dir.trim() : "";
  }

  /**
   * What the agent's program runs with for the profile: its folder, made on
   * the workspace's host and named by its variable, and its own variables.
   * None for the default profile, or one gone.
   */
  private async profileEnv(
    channel: AgentChannel,
    agent: AgentProfile["agent"],
    profileId: string | undefined,
  ): Promise<Record<string, string>> {
    const profile = profileId ? this.options.profile?.(profileId) : null;
    if (!profile || profile.agent !== agent) return {};
    const env: Record<string, string> = { ...(profile.env ?? {}) };
    if (profile.dir.trim() !== "") {
      const result = await channel.call<{ dir: string; failed?: string[] }>("chat.profileDir", {
        agent,
        dir: profile.dir.trim(),
        shared: profile.shared ?? [],
        shareable: SHAREABLE[agent],
      });
      if (result.failed && result.failed.length > 0) {
        log.warn(`profile ${profile.id}: could not link ${result.failed.join(", ")}`);
      }
      env[PROFILE_DIR_ENV[agent]] = result.dir;
    }
    return env;
  }

  /** Forgets a removed workspace. Its agent ends its programs as it shuts down. */
  closeWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
    this.subscriptions.get(workspaceId)?.dispose();
    this.subscriptions.delete(workspaceId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeProviderReady();
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
    this.workspaces.clear();
  }

  private async channelFor(workspaceId: string): Promise<AgentChannel> {
    const channel = await this.options.workspaceManager.getAgentChannel(workspaceId);
    await channel.ready;
    this.workspaces.add(workspaceId);
    this.subscribe(workspaceId, channel);
    return channel;
  }

  /** What the hooks leave untold of a tab's Claude: a turn stopped, the program gone. */
  private noteForStatus(event: string, payload: Record<string, unknown>): void {
    const workspaceId = payload.workspaceId as string;
    const tabId = typeof payload.tabId === "string" ? payload.tabId : null;
    if (!tabId) return;
    if (event === "exit") {
      this.options.onProgramExit?.(workspaceId, tabId);
      return;
    }
    if (payload.replay === true || payload.dir !== "out") return;
    const message = payload.message as Record<string, unknown> | null | undefined;
    if (message?.type !== "result") return;
    const reason = typeof message.terminal_reason === "string" ? message.terminal_reason : "";
    if (message.subtype !== "success" || reason.startsWith("aborted")) {
      this.options.onTurnStopped?.(workspaceId, tabId);
    }
  }

  /** Relays one channel's chat events, once per channel. */
  private subscribe(workspaceId: string, channel: AgentChannel): void {
    const existing = this.subscriptions.get(workspaceId);
    if (existing?.channel === channel || this.disposed) return;
    existing?.dispose();

    // An agent speaks only for its own workspace's tabs.
    const relay = (event: string) => (payload: unknown) => {
      const claimed = (payload as { workspaceId?: unknown } | null)?.workspaceId;
      if (claimed !== workspaceId) {
        log.warn(
          `Dropped chat.${event} for workspace ${String(claimed)} from ${workspaceId}'s agent`,
        );
        return;
      }
      this.options.broadcast(event, payload);
      this.noteForStatus(event, payload as Record<string, unknown>);
    };
    const offLine = channel.on("chat.line", relay("line"));
    const offExit = channel.on("chat.exit", relay("exit"));
    const offLifecycle = channel.onLifecycle((event) => this.handleLifecycle(workspaceId, event));
    this.subscriptions.set(workspaceId, {
      channel,
      dispose: () => {
        offLine();
        offExit();
        offLifecycle();
      },
    });
  }

  /**
   * A dropped connection holds the tabs; the same agent back (a daemon that
   * survived) has them replay what they missed. A new agent comes through
   * onProviderReady.
   */
  private handleLifecycle(workspaceId: string, event: ChannelLifecycleEvent): void {
    switch (event.type) {
      case "reconnecting":
        this.options.broadcast("held", { workspaceId });
        return;
      case "ready":
      // A new daemon behind the same channel: the tabs find it has no logs.
      case "held-then-expired":
        this.options.broadcast("resync", { workspaceId });
        return;
      case "failure":
      case "exit":
        this.subscriptions.get(workspaceId)?.dispose();
        this.subscriptions.delete(workspaceId);
        this.options.broadcast("held", { workspaceId });
        return;
      default:
        return;
    }
  }
}
