// Main-process side of the Claude tabs: starts each tab's program through
// the workspace's agent and relays its chat.* events to the renderer.

import { randomUUID } from "node:crypto";
import {
  type AgentProfile,
  PROFILE_DIR_ENV,
  SHAREABLE,
} from "../../../shared/agent-profiles/profiles";
import { createLogger } from "../../../shared/log/main";
import type { AgentChannel, ChannelLifecycleEvent } from "../../infra/agent/channel";
import type { ChatAgentContext } from "../cli/commands/agent-context";
import type { WindowsAgentFiles } from "../pty/windows-shell-shim";
import type { HookInfo } from "../workspace/manager";
import { tabHookToken } from "../workspace/tab-token";
import {
  CLAUDE_TAB_PROMPT,
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
/** How long workspace removal waits for its chats, including queued requests. */
const WORKSPACE_CHAT_CLOSE_MS = 5000;
/** How long a `claude` command may take: an install fetches the plugin. */
const COMMAND_TIMEOUT_MS = 30_000;

export interface ChatWorkspaceManager {
  getAgentChannel(workspaceId: string): Promise<AgentChannel>;
  tryGetAgentChannel(workspaceId: string): Promise<AgentChannel | null>;
  onProviderReady(listener: (workspaceId: string) => void): () => void;
  getSpawnHookInfo(workspaceId: string, channel: AgentChannel): Promise<HookInfo | null>;
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
  /** Saved chat tabs that may still have a program even before their view opens. */
  knownChatTabs?: (workspaceId: string) => readonly string[];
  /** The agent profile of that id, as the app state has it; null when gone. */
  profile?: (id: string) => AgentProfile | null;
  /** CLI guidance for the node hosting this chat tab, when enabled in Settings. */
  agentContext?: (workspaceId: string, tabId: string) => ChatAgentContext | undefined;
}

export type StartResult =
  | { ok: true; pid: number; attached: boolean; version: string | null; canonicalCwd?: string }
  | { ok: false; reason: "not-found" | "failed"; message: string };

interface Subscription {
  channel: AgentChannel;
  revision: number;
  processes: Map<string, { generation: string; startSeq: number }>;
  dispose: () => void;
}

interface TabIntent {
  generation: string;
  starts: Set<Promise<unknown>>;
}

interface WorkspaceChatClose {
  readonly channel: AgentChannel | null;
  readonly deadline: number;
  readonly expired: Promise<never>;
}

/** Owns chat programs and events for the desktop's workspace channels. */
export class ChatHost {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly tabIntents = new Map<string, TabIntent>();
  private readonly closingTabs = new Map<string, Promise<unknown>>();
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
          await this.options.workspaceManager.getSpawnHookInfo(workspaceId, channel);
          if (this.disposed || !this.workspaces.has(workspaceId)) return;
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
    const key = `${workspaceId}:${tabId}`;
    const intent = this.openTab(key);
    const channel = await this.channelForStart(workspaceId, key, intent);
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
    try {
      const profile = await this.profileEnv(channel, "claude", profileId);
      await this.closingTabs.get(key);
      const hookInfo = await workspaceManager.getSpawnHookInfo(workspaceId, channel);
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
      Object.assign(env, profile);
      const result = await this.spawn(key, intent, channel, {
        workspaceId,
        tabId,
        cwd,
        program,
        args: claudeTabArgs(resume, hooksSettings, version),
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
    const key = `${workspaceId}:${tabId}`;
    const intent = this.openTab(key);
    const channel = await this.channelForStart(workspaceId, key, intent);
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
    // Windows commands run in PowerShell or cmd, which read no shim files.
    const windows =
      this.options.windowsAgentFiles !== undefined &&
      workspaceManager.isLocal?.(workspaceId) === true;
    try {
      const profile = await this.profileEnv(channel, "codex", options.profileId);
      await this.closingTabs.get(key);
      const hookInfo = await workspaceManager.getSpawnHookInfo(workspaceId, channel);
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
      Object.assign(env, profile);
      const result = await this.spawn(key, intent, channel, {
        workspaceId,
        tabId,
        cwd,
        program: found.path,
        args: ["app-server"],
        env,
        ...(options.resetLog ? { resetLog: true } : {}),
      });
      return {
        ok: true,
        pid: result.pid,
        attached: result.attached === true,
        version,
        ...(result.canonicalCwd ? { canonicalCwd: result.canonicalCwd } : {}),
      };
    } catch (err) {
      return { ok: false, reason: "failed", message: (err as Error).message };
    }
  }

  /** Marks a tab as wanted before any asynchronous startup preparation. */
  private openTab(key: string): TabIntent {
    const known = this.tabIntents.get(key);
    if (known) return known;
    const intent = { generation: randomUUID(), starts: new Set<Promise<unknown>>() };
    this.tabIntents.set(key, intent);
    return intent;
  }

  /** Starts only the still-wanted tab. */
  private async spawn(
    key: string,
    intent: TabIntent,
    channel: AgentChannel,
    params: Record<string, unknown>,
  ): Promise<{ pid: number; attached?: boolean; canonicalCwd?: string }> {
    if (this.tabIntents.get(key) !== intent) throw new Error("chat tab closed before it started");
    const run = channel.call<{ pid: number; attached?: boolean; canonicalCwd?: string }>(
      "chat.start",
      {
        ...params,
        tabGeneration: intent.generation,
      },
    );
    intent.starts.add(run);
    try {
      return await run;
    } finally {
      intent.starts.delete(run);
    }
  }

  /** Invalidates preparation at once and closes any start already sent to the agent. */
  private async closeTab(
    workspaceId: string,
    tabId: string,
    removal?: WorkspaceChatClose,
  ): Promise<unknown> {
    const key = `${workspaceId}:${tabId}`;
    const intent = this.tabIntents.get(key);
    const previous = this.closingTabs.get(key);
    if (previous && !intent && !removal) return previous;
    this.tabIntents.delete(key);
    const close = async () => {
      if (removal?.channel === null) return;
      if (previous) {
        if (!intent) return previous;
        await previous.catch(() => undefined);
      }
      if (intent) await Promise.allSettled(intent.starts);
      const params = {
        workspaceId,
        tabId,
        ...(intent ? { tabGeneration: intent.generation } : {}),
      };
      if (removal) {
        const timeoutMs = removal.deadline - Date.now();
        if (timeoutMs <= 0) return removal.expired;
        return removal.channel.call("chat.close", params, { timeoutMs });
      }
      const channel = await this.options.workspaceManager.tryGetAgentChannel(workspaceId);
      return channel?.call("chat.close", params);
    };
    const run = (async () => {
      try {
        return await (removal ? Promise.race([close(), removal.expired]) : close());
      } finally {
        this.subscriptions.get(workspaceId)?.processes.delete(tabId);
        this.options.onProgramExit?.(workspaceId, tabId);
      }
    })();
    this.closingTabs.set(key, run);
    try {
      return await run;
    } finally {
      if (this.closingTabs.get(key) === run) this.closingTabs.delete(key);
    }
  }

  async send(workspaceId: string, tabId: string, message: Record<string, unknown>): Promise<void> {
    const channel = await this.channelFor(workspaceId);
    const note =
      message.method === "turn/start" ? this.options.agentContext?.(workspaceId, tabId) : undefined;
    await channel.call("chat.send", {
      workspaceId,
      tabId,
      message,
      ...(message.method === "turn/start"
        ? { codexContext: { files: CLAUDE_TAB_PROMPT, cli: note } }
        : {}),
    });
  }

  async call(
    method: "stop" | "close" | "replay" | "attach" | "pruneAttachments",
    args: unknown,
  ): Promise<unknown> {
    const { workspaceId, tabId } = args as { workspaceId: string; tabId: string };
    if (method === "close") return this.closeTab(workspaceId, tabId);
    return (await this.channelFor(workspaceId)).call(`chat.${method}`, args);
  }

  async transcript(workspaceId: string, sessionId: string, profileId?: string): Promise<unknown> {
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.transcript", { sessionId, ...this.configDir(profileId) });
  }

  async subagentTranscript(
    workspaceId: string,
    sessionId: string,
    agent: { agentId?: string; toolUseId?: string },
    profileId?: string,
  ): Promise<unknown> {
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.subagentTranscript", {
      sessionId,
      ...agent,
      ...this.configDir(profileId),
    });
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
   * What a terminal opened for a profile runs with in the workspace, as a
   * chat of it does: its folder's variable and its own variables. Null for
   * a profile there is not.
   */
  async terminalProfileEnv(
    workspaceId: string,
    profileId: string,
  ): Promise<Record<string, string> | null> {
    const profile = this.options.profile?.(profileId);
    if (!profile) return null;
    const channel = await this.options.workspaceManager.getAgentChannel(workspaceId);
    await channel.ready;
    return this.profileEnv(channel, profile.agent, profile.id);
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

  /** Closes tracked and restored chats before the workspace's agent is torn down. */
  async closeWorkspace(workspaceId: string, channel: AgentChannel | null): Promise<void> {
    const subscription = this.subscriptions.get(workspaceId);
    const tabIds = new Set(this.options.knownChatTabs?.(workspaceId));
    for (const tabId of subscription?.processes.keys() ?? []) tabIds.add(tabId);
    const prefix = `${workspaceId}:`;
    for (const keys of [this.tabIntents.keys(), this.closingTabs.keys()]) {
      for (const key of keys) {
        if (key.startsWith(prefix)) tabIds.add(key.slice(prefix.length));
      }
    }
    this.workspaces.delete(workspaceId);
    subscription?.dispose();
    this.subscriptions.delete(workspaceId);
    if (tabIds.size === 0) return;
    const deadline = Date.now() + WORKSPACE_CHAT_CLOSE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("chat.close timed out")), WORKSPACE_CHAT_CLOSE_MS);
    });
    const removal = { channel, deadline, expired };
    const results = await Promise.allSettled(
      Array.from(tabIds, (tabId) => this.closeTab(workspaceId, tabId, removal)),
    ).finally(() => clearTimeout(timer));
    for (const result of results) {
      if (result.status === "rejected")
        log.warn(
          `could not close a chat in removed workspace ${workspaceId}: ${String(result.reason)}`,
        );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeProviderReady();
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
    this.workspaces.clear();
    this.tabIntents.clear();
  }

  /** Drops exit and result events that belong to a replaced program. */
  private acceptProcessEvent(event: string, payload: Record<string, unknown>): boolean {
    const { workspaceId, tabId, replay } = payload;
    if (typeof workspaceId !== "string" || typeof tabId !== "string") return true;
    const processes = this.subscriptions.get(workspaceId)?.processes;
    if (!processes) return true;
    const current = processes.get(tabId);
    const message = payload.message as { event?: unknown; processGeneration?: unknown } | undefined;
    if (event === "line" && payload.dir === "sys" && message?.event === "start") {
      const startSeq = typeof payload.seq === "number" ? payload.seq : 0;
      if (typeof message.processGeneration === "string") {
        if (!replay || !current || startSeq > current.startSeq) {
          processes.set(tabId, { generation: message.processGeneration, startSeq });
        }
      } else if (!replay) {
        processes.delete(tabId);
      }
      return true;
    }
    return (
      replay === true ||
      typeof payload.processGeneration !== "string" ||
      !current ||
      current.generation === payload.processGeneration
    );
  }

  private async channelFor(workspaceId: string): Promise<AgentChannel> {
    const channel = await this.options.workspaceManager.getAgentChannel(workspaceId);
    await channel.ready;
    this.workspaces.add(workspaceId);
    this.subscribe(workspaceId, channel);
    return channel;
  }

  /** Releases an intent whose start could not reach a workspace agent. */
  private async channelForStart(
    workspaceId: string,
    key: string,
    intent: TabIntent,
  ): Promise<AgentChannel> {
    try {
      return await this.channelFor(workspaceId);
    } catch (error) {
      if (this.tabIntents.get(key) === intent && intent.starts.size === 0)
        this.tabIntents.delete(key);
      throw error;
    }
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
      const frame = payload as Record<string, unknown>;
      if (!this.acceptProcessEvent(event, frame)) return;
      this.options.broadcast(event, payload);
      this.noteForStatus(event, frame);
    };
    const offLine = channel.on("chat.line", relay("line"));
    const offExit = channel.on("chat.exit", relay("exit"));
    const subscription: Subscription = {
      channel,
      revision: 0,
      processes: new Map(),
      dispose: () => {
        offLine();
        offExit();
        offLifecycle();
      },
    };
    const offLifecycle = channel.onLifecycle((event) =>
      this.handleLifecycle(workspaceId, subscription, event),
    );
    this.subscriptions.set(workspaceId, subscription);
  }

  /**
   * A dropped connection holds the tabs. A replacement local process needs
   * its hook endpoint before the tabs can resume. A surviving daemon can
   * replay immediately.
   */
  private handleLifecycle(
    workspaceId: string,
    subscription: Subscription,
    event: ChannelLifecycleEvent,
  ): void {
    switch (event.type) {
      case "reconnecting":
        subscription.revision += 1;
        if (this.options.workspaceManager.isLocal?.(workspaceId)) subscription.processes.clear();
        this.options.broadcast("held", { workspaceId });
        return;
      case "ready":
        if (this.options.workspaceManager.isLocal?.(workspaceId)) {
          void this.resyncAfterHooks(workspaceId, subscription);
          return;
        }
        this.options.broadcast("resync", { workspaceId });
        return;
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

  /** Resyncs only if this ready event still belongs to the live connection. */
  private async resyncAfterHooks(workspaceId: string, subscription: Subscription): Promise<void> {
    const { revision, channel } = subscription;
    try {
      await this.options.workspaceManager.getSpawnHookInfo(workspaceId, channel);
      if (
        this.subscriptions.get(workspaceId) === subscription &&
        revision === subscription.revision
      ) {
        this.options.broadcast("resync", { workspaceId });
      }
    } catch (error) {
      log.warn(`chat reconnect failed for ${workspaceId}: ${(error as Error).message}`);
    }
  }
}
