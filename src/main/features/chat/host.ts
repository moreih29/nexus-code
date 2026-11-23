// Main-process side of the Claude tabs: starts each tab's program through
// the workspace's agent and relays its chat.* events to the renderer.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gte } from "semver";
import {
  connectionDefaultModel,
  connectionKeyTarget,
} from "../../../shared/agent-profiles/connection";
import {
  agentEnvValue,
  mergeAgentEnv,
  profileDirectory,
  profileVariables,
} from "../../../shared/agent-profiles/env";
import {
  type AgentProfile,
  defaultProfileId,
  PROFILE_DIR_ENV,
  SHAREABLE,
} from "../../../shared/agent-profiles/profiles";
import { type ClaudeTurnResult, claudeTurnResult } from "../../../shared/claude/turn-result";
import type {
  ChatPeekTail,
  PrintRunReaderResult,
  PrintRunTranscriptResult,
  TranscriptPageResult,
} from "../../../shared/ipc/contract";
import { createLogger } from "../../../shared/log/main";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { tryGetMainT } from "../../i18n";
import type { AgentChannel, ChannelLifecycleEvent } from "../../infra/agent/channel";
import {
  claudeConnectionEnv,
  claudeModelPicker,
  codexConnectionArgs,
  codexConnectionCatalog,
  codexConnectionEnv,
} from "../agent-profiles/connection-launch";
import type { PrintRunSource } from "../claude/session-activity";
import type { ChatAgentContext } from "../cli/commands/agent-context";
import type { WindowsAgentFiles } from "../pty/windows-shell-shim";
import type { HookInfo } from "../workspace/manager";
import { tabHookToken } from "../workspace/tab-token";
import {
  type ClaudeInstructionHook,
  claudeInstructionLaunch,
  claudeInstructionLaunchState,
  claudeInstructionUpdate,
  claudeResumeId,
  instructionSessionId,
} from "./instructions";
import {
  CLAUDE_TAB_PROMPT,
  type ClaudeCommand,
  claudeCommandArgs,
  claudeTabArgs,
  claudeTabEnv,
  claudeTabPrompt,
  codexTabEnv,
  hostJoin,
  parseClaudeVersion,
  type ResumeOptions,
  takesAppendPromptFile,
  windowsCommandLineTooLong,
} from "./launch";
import { OAuthCallbacks } from "./oauth-callback";
import type { PromptFiles } from "./prompt-files";

const log = createLogger("chat-host");

/** How long `claude --version` may take: a first run can unpack itself. */
const VERSION_TIMEOUT_MS = 20_000;
/** The first Claude Code release with modelPicker in --settings. */
const CUSTOM_CLAUDE_FROM = "2.1.242";

function missingApiKeyMessage(): string {
  return (
    tryGetMainT()?.("settings:profiles.connection.errors.missingKey") ??
    "Set the profile API key in Settings."
  );
}
/** How long workspace removal waits for its chats, including queued requests. */
const WORKSPACE_CHAT_CLOSE_MS = 5000;
/** How long a `claude` command may take: an install fetches the plugin. */
const COMMAND_TIMEOUT_MS = 30_000;
/** The agent needs time to close the child's pipes and return its timed-out result. */
const COMMAND_REPLY_TIMEOUT_MS = COMMAND_TIMEOUT_MS + 5_000;

export interface ChatWorkspaceManager {
  getAgentChannel(workspaceId: string): Promise<AgentChannel>;
  tryGetAgentChannel(workspaceId: string): Promise<AgentChannel | null>;
  onProviderReady(listener: (workspaceId: string) => void): () => void;
  getSpawnHookInfo(workspaceId: string, channel: AgentChannel): Promise<HookInfo | null>;
  getWrapperBinDir(workspaceId: string): string | null;
  getWrapperAgentBin(workspaceId: string): string | null;
  getWrapperShimDir(workspaceId: string): string | null;
  isLocal?(workspaceId: string): boolean;
  /** The workspace's agent channel only while it is up: an SSH host is not dialed. */
  peekAgentChannel?(workspaceId: string): Promise<AgentChannel | null>;
  /**
   * The host and user whose attach folder the workspace's agent writes in,
   * the same for every workspace there (attachHostOf); null when unknown.
   */
  attachHost?(workspaceId: string): string | null;
}

/** How long an attached file no open tab uses stays unused before a prune removes it. */
export const ATTACH_UNUSED_MS = 30 * 24 * 60 * 60 * 1000;
/** The most a workspace's attached files hold; past it a prune removes the least recently used. */
export const ATTACH_ROOM_BYTES = 1024 * 1024 * 1024;

/**
 * The attach root an agent told, or null when it names none. One on a network
 * share (`\\server\share`, `//server/share`) counts as none: the app does not
 * read slots from it (attachRootOf), so it could name none an open tab keeps,
 * and nothing kept past its tab there would ever go.
 */
function namedRoot(root: unknown): string | null {
  if (typeof root !== "string" || root === "") return null;
  return /^[\\/]{2}/.test(root) ? null : root;
}

/** Removed workspaces whose attached files wait for an agent on their host to remove them. */
export interface AttachCleanups {
  add(host: string, workspaceId: string): void;
  /** The workspaces waiting on the host. */
  waiting(host: string): string[];
  /** One no longer waits: its folder went. */
  remove(host: string, workspaceId: string): void;
}

/** The tab ids of the app-servers that read a `codex exec` run's thread. */
const PRINT_RUN_READER_PREFIX = "print-run-reader-";

export function isPrintRunReader(tabId: string): boolean {
  return tabId.startsWith(PRINT_RUN_READER_PREFIX);
}

/** What a run's reader is told: the handshake and reads of a thread, nothing that changes one. */
const PRINT_RUN_READER_METHODS = new Set([
  "initialize",
  "initialized",
  "thread/read",
  "thread/turns/list",
]);

export interface ChatHostOptions {
  workspaceManager: ChatWorkspaceManager;
  broadcast: (event: string, args: unknown) => void;
  /** On Windows, where local claude runs without the bash wrapper. */
  windowsAgentFiles?: () => Promise<WindowsAgentFiles | null>;
  /**
   * On Windows, where a tab's instructions go to claude in a file: the
   * command line has no room for them once escaped.
   */
  promptFiles?: PromptFiles;
  /** The result a Claude chat reported on its stream. */
  onTurnResult?: (workspaceId: string, tabId: string, result: ClaudeTurnResult) => void;
  /** The lifecycle messages for a Claude chat's background tasks. */
  onTaskEvent?: (workspaceId: string, tabId: string, message: Record<string, unknown>) => void;
  /**
   * Where a tab's `claude -p` or `codex exec` run keeps its session, as the
   * app recorded it from the run's start: undefined for a run not of that tab.
   */
  printRunSource?: (
    workspaceId: string,
    tabId: string,
    runId: string,
  ) => PrintRunSource | undefined;
  /** A tab's program exited. */
  onProgramExit?: (workspaceId: string, tabId: string) => void;
  /** Saved chat tabs that may still have a program even before their view opens. */
  knownChatTabs?: (workspaceId: string) => readonly string[];
  /** The agent profile of that id, as the app state has it; null when gone. */
  profile?: (id: string) => AgentProfile | null;
  connectionKey?: (id: string, target: string | undefined) => Promise<string | undefined>;
  /** CLI guidance for the node hosting this chat tab, when enabled in Settings. */
  agentContext?: (
    workspaceId: string,
    tabId: string,
    session?: string,
  ) => Promise<ChatAgentContext | undefined> | undefined;
  instructions?: (workspaceId: string, profile: AgentProfile, session?: string) => string;
  claudeInstructionDigests?: {
    get(workspaceId: string, sessionId: string): string | null | undefined;
    save(workspaceId: string, sessionId: string, digest: string | null): void;
  };
  savedClaudeInstructions?: (
    workspaceId: string,
    tabId: string,
  ) => { profileId?: string; instructions?: string } | undefined;
  /** Where a removed workspace's attached files wait when its host's agent was not up. */
  attachCleanups?: AttachCleanups;
}

export type StartResult =
  | { ok: true; pid: number; attached: boolean; version: string | null; canonicalCwd?: string }
  | { ok: false; reason: "not-found" | "failed"; message: string };

/** A profile choice that is no longer valid for this agent. */
export class AgentProfileSelectionError extends Error {}

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
  readonly oauth = new OAuthCallbacks();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly tabIntents = new Map<string, TabIntent>();
  private readonly claudeInstructions = new Map<
    string,
    { profileId?: string; instructions?: string }
  >();
  private readonly claudeInstructionUpdates = new Map<
    string,
    { launch: string; sessionId?: string; digest: string | null }
  >();
  /** The prompt file of each Claude tab's current program. */
  private readonly promptFiles = new Map<string, string>();
  /** Tabs whose new prompt file is not yet taken by a started program. */
  private readonly promptStarting = new Set<string>();
  private readonly closingTabs = new Map<string, Promise<unknown>>();
  /** Workspaces whose tabs have started a program through this host. */
  private readonly workspaces = new Set<string>();
  /** What each agent connection answered chat.attachRoot with (askAttachRoot): asked once a connection. */
  private readonly attachRoots = new WeakMap<AgentChannel, Promise<string | null | undefined>>();
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
    instructions?: string,
  ): Promise<StartResult> {
    let profile: AgentProfile;
    try {
      profile = this.profile("claude", profileId);
    } catch (error) {
      return { ok: false, reason: "failed", message: (error as Error).message };
    }
    const key = `${workspaceId}:${tabId}`;
    const intent = this.openTab(key);
    const channel = await this.channelForStart(workspaceId, key, intent);
    const { workspaceManager } = this.options;
    const windows = this.windowsHost(workspaceId);
    const withoutWrapper = windows && this.options.windowsAgentFiles !== undefined;

    let profileEnv: Record<string, string>;
    try {
      profileEnv = await this.profileEnv(channel, profile, windows, true);
    } catch (error) {
      return { ok: false, reason: "failed", message: (error as Error).message };
    }
    const found = await this.findBinary(channel, "claude", cwd, profileEnv, windows);
    if (!found.path) {
      return { ok: false, reason: "not-found", message: "claude was not found on the PATH" };
    }

    const path = agentEnvValue(profileEnv, "PATH", windows) ?? found.envPath;
    const launchEnv = mergeAgentEnv(windows, profileEnv, path === undefined ? {} : { PATH: path });
    const version = await this.probeVersion(channel, "claude", cwd, found.path, launchEnv);

    if (resume.usageOnly) {
      try {
        const result = await this.spawn(key, intent, channel, {
          workspaceId,
          tabId,
          cwd,
          program: found.path,
          args: claudeTabArgs(resume),
          env: launchEnv,
        });
        return { ok: true, pid: result.pid, attached: result.attached === true, version };
      } catch (err) {
        return { ok: false, reason: "failed", message: (err as Error).message };
      }
    }

    if (profile.connection?.method === "custom" && version && !gte(version, CUSTOM_CLAUDE_FROM)) {
      return {
        ok: false,
        reason: "failed",
        message:
          tryGetMainT()?.("settings:profiles.connection.errors.claudeVersion", {
            version: CUSTOM_CLAUDE_FROM,
          }) ?? `Custom API addresses require Claude Code ${CUSTOM_CLAUDE_FROM} or later.`,
      };
    }
    const wrapperBinDir = workspaceManager.getWrapperBinDir(workspaceId);
    const agentBin = workspaceManager.getWrapperAgentBin(workspaceId);
    let program = found.path;
    let hooksSettings: string | undefined;
    let gitBash: { wrapperDir: string; bashEnv: string } | undefined;
    if (withoutWrapper) {
      // cmd and PowerShell pass claude the hooks file the same way.
      const files = await this.options.windowsAgentFiles?.();
      hooksSettings = files?.settingsPath;
      const shimDir = workspaceManager.getWrapperShimDir(workspaceId);
      if (files && shimDir !== null) {
        gitBash = { wrapperDir: files.binDir, bashEnv: hostJoin(shimDir, "bashenv", true) };
      }
    } else if (wrapperBinDir !== null) {
      // The wrapper adds the hooks and the tab's mark, then runs the claude
      // version probe selected.
      program = hostJoin(wrapperBinDir, "claude", false);
    }
    try {
      await this.closingTabs.get(key);
      const hookInfo = await workspaceManager.getSpawnHookInfo(workspaceId, channel);
      const env = claudeTabEnv({
        workspaceId,
        tabId,
        path,
        wrapperBinDir,
        agentBin,
        agentSocket: hookInfo?.socketPath,
        hookToken: hookInfo ? tabHookToken(hookInfo, workspaceId, tabId) : undefined,
        withoutWrapper,
        ...(gitBash ? { gitBash } : {}),
      });
      if (program !== found.path) env.NEXUS_CLAUDE_PROGRAM = found.path;
      const combined = this.options.instructions?.(workspaceId, profile, instructions) ?? "";
      const sourceId = resume.fork ? claudeResumeId(resume.resume) : undefined;
      const sourceDigest = sourceId
        ? this.options.claudeInstructionDigests?.get(workspaceId, sourceId)
        : undefined;
      env.NEXUS_CHAT_INSTRUCTION_LAUNCH = claudeInstructionLaunch(
        combined,
        sourceId && sourceDigest !== undefined
          ? { sessionId: sourceId, digest: resume.resumeAt === undefined ? sourceDigest : null }
          : undefined,
      );
      this.claudeInstructions.set(key, { profileId, instructions });
      const modelPicker = claudeModelPicker(profile.connection);
      let settings = hooksSettings;
      if (modelPicker) {
        if (program !== found.path) {
          // The shell wrapper adds its hooks to this JSON before passing --settings.
          env.NEXUS_CLAUDE_MODEL_PICKER = JSON.stringify(modelPicker);
        } else {
          const hooks = hooksSettings ? JSON.parse(await readFile(hooksSettings, "utf8")) : {};
          settings = JSON.stringify({ ...hooks, modelPicker });
        }
      }
      let promptFile: string | undefined;
      const files = this.options.promptFiles;
      if (windows && files && combined !== "" && takesAppendPromptFile(version)) {
        this.promptStarting.add(key);
        await this.removePromptFile(key);
        try {
          promptFile = await files.write(tabId, claudeTabPrompt(combined));
          this.promptFiles.set(key, promptFile);
        } catch {
          // Not the error's text: it may name the file.
          log.warn("instructions file could not be written");
          this.promptStarting.delete(key);
        }
      }
      const args = claudeTabArgs(resume, settings, version, combined, promptFile);
      const defaultModel = connectionDefaultModel(profile);
      if (defaultModel) args.push(`--model=${defaultModel}`);
      if (windows && windowsCommandLineTooLong(program, args)) {
        this.promptStarting.delete(key);
        await this.removePromptFile(key);
        return {
          ok: false,
          reason: "failed",
          message:
            tryGetMainT()?.("errors:chat.commandLineTooLong") ??
            "The instructions are too long for Windows to start Claude Code. Shorten them and try again.",
        };
      }
      let result: { pid: number; attached?: boolean };
      try {
        result = await this.spawn(key, intent, channel, {
          workspaceId,
          tabId,
          cwd,
          program,
          args,
          env: mergeAgentEnv(windows, profileEnv, env),
          ...(resume.resetLog ? { resetLog: true } : {}),
          ...(resume.connectionChanged ? { connectionChanged: true } : {}),
          ...(resume.resume !== undefined ? { resumed: true } : {}),
        });
      } catch (err) {
        await this.removePromptFile(key);
        throw err;
      } finally {
        this.promptStarting.delete(key);
      }
      // A program the agent still ran took no new prompt.
      if (result.attached === true) await this.removePromptFile(key);
      return { ok: true, pid: result.pid, attached: result.attached === true, version };
    } catch (err) {
      return { ok: false, reason: "failed", message: (err as Error).message };
    }
  }

  /** Removes the tab's prompt file, once its program has read it or is gone. */
  private async removePromptFile(key: string): Promise<void> {
    const file = this.promptFiles.get(key);
    if (file === undefined) return;
    this.promptFiles.delete(key);
    await this.options.promptFiles?.remove(file);
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
    options: { resetLog?: boolean; connectionChanged?: boolean; profileId?: string },
  ): Promise<StartResult> {
    let profile: AgentProfile;
    try {
      profile = this.profile("codex", options.profileId);
    } catch (error) {
      return { ok: false, reason: "failed", message: (error as Error).message };
    }
    const key = `${workspaceId}:${tabId}`;
    const intent = this.openTab(key);
    const channel = await this.channelForStart(workspaceId, key, intent);
    const windows = this.windowsHost(workspaceId);
    let profileEnv: Record<string, string>;
    let apiKey: string | undefined;
    try {
      profileEnv = await this.profileEnv(channel, profile, windows);
      apiKey = await this.profileConnectionKey(profile);
      if (profile.connection?.method === "api-key" && !apiKey)
        throw new Error(missingApiKeyMessage());
      profileEnv = mergeAgentEnv(
        windows,
        profileEnv,
        codexConnectionEnv(profile.connection, apiKey),
      );
    } catch (error) {
      return { ok: false, reason: "failed", message: (error as Error).message };
    }
    const found = await this.findBinary(channel, "codex", cwd, profileEnv, windows);
    if (!found.path) {
      return { ok: false, reason: "not-found", message: "codex was not found on the PATH" };
    }
    const path = agentEnvValue(profileEnv, "PATH", windows) ?? found.envPath;
    const version = await this.probeVersion(
      channel,
      "codex",
      cwd,
      found.path,
      mergeAgentEnv(windows, profileEnv, path === undefined ? {} : { PATH: path }),
    );

    const { workspaceManager } = this.options;
    try {
      await this.closingTabs.get(key);
      const hookInfo = await workspaceManager.getSpawnHookInfo(workspaceId, channel);
      const env = codexTabEnv({
        workspaceId,
        tabId,
        path,
        wrapperBinDir: workspaceManager.getWrapperBinDir(workspaceId),
        agentBin: workspaceManager.getWrapperAgentBin(workspaceId),
        agentSocket: hookInfo?.socketPath,
        hookToken: hookInfo ? tabHookToken(hookInfo, workspaceId, tabId) : undefined,
        shimDir: windows ? null : workspaceManager.getWrapperShimDir(workspaceId),
      });
      const connection = profile.connection;
      const catalogPath =
        connection?.method === "custom"
          ? await channel.call<string>("chat.writeCodexCatalog", {
              catalog: codexConnectionCatalog(connection),
            })
          : undefined;
      const args = ["app-server", ...codexConnectionArgs(connection, apiKey, catalogPath)];
      const result = await this.spawn(key, intent, channel, {
        workspaceId,
        tabId,
        cwd,
        program: found.path,
        args,
        env: mergeAgentEnv(windows, profileEnv, env),
        ...(options.resetLog ? { resetLog: true } : {}),
        ...(options.connectionChanged ? { connectionChanged: true } : {}),
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
    this.claudeInstructions.delete(key);
    this.claudeInstructionUpdates.delete(key);
    const close = async () => {
      // Whatever follows, the closed tab's file has no use.
      await this.removePromptFile(key);
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
        // A removed workspace's files go with its folder.
        const timeoutMs = removal.deadline - Date.now();
        if (timeoutMs <= 0) return removal.expired;
        return removal.channel.call("chat.close", params, { timeoutMs });
      }
      const channel = await this.options.workspaceManager.tryGetAgentChannel(workspaceId);
      if (!channel) return undefined;
      // Its conversation may go on in another tab, which names its files. Not
      // where the agent names no attach root (a home it cannot name, or an
      // agent from before): no prune there knows what a conversation names,
      // so the files go with the tab, as they did. Kept when asking failed.
      const kept = (await this.askAttachRoot(channel)) !== null;
      return channel.call("chat.close", { ...params, ...(kept ? { keepAttachments: true } : {}) });
    };
    const run = (async () => {
      try {
        return await (removal ? Promise.race([close(), removal.expired]) : close());
      } finally {
        this.subscriptions.get(workspaceId)?.processes.delete(tabId);
        // A run's reader is no tab: nothing waits on its exit.
        if (!isPrintRunReader(tabId)) this.options.onProgramExit?.(workspaceId, tabId);
      }
    })();
    this.closingTabs.set(key, run);
    try {
      return await run;
    } finally {
      if (this.closingTabs.get(key) === run) this.closingTabs.delete(key);
    }
  }

  async send(
    workspaceId: string,
    tabId: string,
    message: Record<string, unknown>,
    layer: { profileId?: string; instructions?: string } = {},
  ): Promise<void> {
    if (isPrintRunReader(tabId) && !PRINT_RUN_READER_METHODS.has(String(message.method))) {
      throw Object.assign(new Error("a run's reader only reads"), {
        code: "chat.reader-read-only",
      });
    }
    const channel = await this.channelFor(workspaceId);
    if (message.type === "user" && layer.instructions !== undefined) {
      this.claudeInstructions.set(`${workspaceId}:${tabId}`, layer);
    }
    const turn = message.method === "turn/start";
    const threadId = (message.params as { threadId?: unknown } | undefined)?.threadId;
    const note = turn
      ? await this.options.agentContext?.(workspaceId, tabId, instructionSessionId(threadId))
      : undefined;
    const instructions =
      turn && this.options.instructions
        ? this.options.instructions(
            workspaceId,
            this.instructionProfile("codex", layer.profileId),
            layer.instructions,
          )
        : undefined;
    await channel.call("chat.send", {
      workspaceId,
      tabId,
      message,
      ...(turn
        ? {
            codexContext: {
              files: CLAUDE_TAB_PROMPT,
              cli: note,
              ...(instructions ? { instructions } : {}),
            },
          }
        : {}),
    });
  }

  /** The hook reports changes against conversation history and restores them after compaction. */
  claudeHookInstructions(
    workspaceId: string,
    tabId: string,
    launch: string,
    hook: ClaudeInstructionHook,
  ): string {
    const launchState = claudeInstructionLaunchState(launch);
    if (!launchState) return "";
    const key = `${workspaceId}:${tabId}`;
    const saved = this.options.savedClaudeInstructions?.(workspaceId, tabId);
    const layer = this.claudeInstructions.get(key) ?? saved;
    if (!layer || !this.options.instructions) return "";

    const sessionId = instructionSessionId(hook.sessionId);
    const stored = sessionId
      ? this.options.claudeInstructionDigests?.get(workspaceId, sessionId)
      : undefined;
    const prior = this.claudeInstructionUpdates.get(key);
    const previous =
      prior?.launch === launch && prior.sessionId === sessionId ? prior.digest : stored;
    const remember = (digest: string | null) => {
      this.claudeInstructionUpdates.set(key, { launch, sessionId, digest });
      if (!sessionId || digest === stored) return;
      try {
        this.options.claudeInstructionDigests?.save(workspaceId, sessionId, digest);
      } catch (error) {
        log.warn(`Could not save Claude's instruction digest: ${(error as Error).message}`);
      }
    };

    if (hook.phase === "start") {
      const fork = launchState.fork;
      // A full fork inherits the source digest. A fork at a message may have
      // omitted that block, so remember that its digest is unknown.
      if (sessionId && fork && sessionId !== fork.sessionId && previous === undefined)
        remember(fork.digest);
      return "";
    }
    const restoring = hook.phase === "restore";
    const profile = this.instructionProfile("claude", layer.profileId);
    // Claude can submit a prompt without going through send(), so prefer the saved session text.
    const session = saved?.instructions ?? layer.instructions;
    const text = this.options.instructions(workspaceId, profile, session);
    const update = claudeInstructionUpdate(launchState.systemDigest, previous, text, restoring);
    if (!update) return "";
    remember(update.digest);
    return update.text;
  }

  async call(method: "stop" | "close" | "replay" | "attach", args: unknown): Promise<unknown> {
    const { workspaceId, tabId } = args as { workspaceId: string; tabId: string };
    if (method === "close") return this.closeTab(workspaceId, tabId);
    return (await this.channelFor(workspaceId)).call(`chat.${method}`, args);
  }

  /**
   * Prunes the workspace's attached files (chat.pruneAttachments): those of
   * no open tab, that no open tab's conversation names, once unused for
   * ATTACH_UNUSED_MS (not with capOnly), and the least recently used past
   * ATTACH_ROOM_BYTES. First the files of removed workspaces left for an
   * agent on the same host go.
   *
   * Without keepSlots (the app did not know the root to name them by), only
   * an agent that names no root prunes: one with a home it cannot name, or
   * one from before. It removed each tab's files as the tab closed; those of
   * every tab not open go, as they did. Nothing goes when asking the agent
   * for its root failed.
   */
  async pruneAttachments({
    workspaceId,
    keepTabIds,
    keepSlots,
    capOnly = false,
  }: {
    workspaceId: string;
    keepTabIds: string[];
    keepSlots?: string[];
    capOnly?: boolean;
  }): Promise<void> {
    const channel = await this.channelFor(workspaceId);
    const root = await this.askAttachRoot(channel);
    if (root === undefined) return;
    if (root === null) {
      // Nothing is kept past its tab there, so there is no room to make.
      if (!capOnly) await channel.call("chat.pruneAttachments", { workspaceId, keepTabIds });
      return;
    }
    // What the open conversations name is not known: nothing goes on a guess.
    if (!keepSlots) return;
    await this.removeWaitingAttachments(workspaceId, channel);
    await channel.call("chat.pruneAttachments", {
      workspaceId,
      keepTabIds,
      // An agent between (it tells its root, not this) removes every closed tab's files, as it did.
      retain: {
        keep: keepSlots,
        maxAgeMs: capOnly ? 0 : ATTACH_UNUSED_MS,
        maxBytes: ATTACH_ROOM_BYTES,
      },
    });
  }

  /**
   * Touches or removes attached files by their slots. An agent from before
   * has neither, nor kept a file past its tab: nothing to do there.
   */
  async attachmentCall(
    method: "touchAttachments" | "removeAttachments",
    args: { workspaceId: string; slots: string[] },
  ): Promise<void> {
    if (args.slots.length === 0) return;
    const channel = await this.channelFor(args.workspaceId);
    await channel.call(`chat.${method}`, args).catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code !== "unsupported-method") throw error;
    });
  }

  /** Removes the folders of removed workspaces whose host is this workspace's. */
  private async removeWaitingAttachments(
    workspaceId: string,
    channel: AgentChannel,
  ): Promise<void> {
    const cleanups = this.options.attachCleanups;
    const host = this.options.workspaceManager.attachHost?.(workspaceId);
    if (!cleanups || !host) return;
    for (const removed of cleanups.waiting(host)) {
      try {
        await channel.call("chat.removeAttachments", {
          workspaceId: removed,
          slots: [],
          all: true,
        });
      } catch (error) {
        // An agent from before removed each tab's files as it closed: nothing waits there.
        if ((error as { code?: unknown } | null)?.code !== "unsupported-method") {
          // It waits on, for the next time.
          log.warn(
            `could not remove removed workspace ${removed}'s attached files: ${String(error)}`,
          );
          continue;
        }
      }
      cleanups.remove(host, removed);
    }
  }

  /**
   * Removes a removed workspace's attached files, its whole folder; left for
   * the next prune on the same host when its agent is not up or fails.
   */
  private async removeWorkspaceAttachments(
    workspaceId: string,
    channel: AgentChannel | null,
    host: string | null,
    deadline: number,
  ): Promise<void> {
    const wait = () => {
      if (host) this.options.attachCleanups?.add(host, workspaceId);
    };
    if (!channel || deadline <= Date.now()) return wait();
    const root = await this.askAttachRootBy(channel, deadline);
    // An agent that names no root kept no file past its tab: they went as the tabs closed.
    if (root === null) return;
    const timeoutMs = deadline - Date.now();
    if (root === undefined || timeoutMs <= 0) return wait();
    try {
      await channel.call(
        "chat.removeAttachments",
        { workspaceId, slots: [], all: true },
        { timeoutMs },
      );
    } catch (error) {
      // An agent from before removed each tab's files as it closed.
      if ((error as { code?: unknown } | null)?.code === "unsupported-method") return;
      log.warn(
        `could not remove removed workspace ${workspaceId}'s attached files: ${String(error)}`,
      );
      wait();
    }
  }

  /**
   * Where the workspace's agent writes the files attached to a message, as
   * the agent tells it (chat.attachRoot): it alone knows its NEXUS_CODE_HOME
   * and home folder, on whatever host. Null with no agent up (an SSH host
   * is not dialed for it), from an agent too old to tell, or when asking
   * fails; asked again on the next connection, or after a failure.
   */
  async attachRoot(workspaceId: string): Promise<string | null> {
    const channel = await this.options.workspaceManager
      .peekAgentChannel?.(workspaceId)
      .catch(() => null);
    if (!channel) return null;
    return (await this.askAttachRoot(channel)) ?? null;
  }

  /**
   * The attach root the agent on `channel` tells (chat.attachRoot): null
   * when it names none, from a home it cannot name or as an agent too old
   * to tell, or one on a network share (namedRoot), which stays so for the
   * connection; undefined when asking failed, which is asked again next time.
   */
  private askAttachRoot(channel: AgentChannel): Promise<string | null | undefined> {
    const known = this.attachRoots.get(channel);
    if (known) return known;
    const asked = channel.ready
      .then(() => channel.call<{ root?: unknown }>("chat.attachRoot", {}))
      .then(
        (result) => namedRoot(result?.root),
        (error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === "unsupported-method") return null;
          this.attachRoots.delete(channel);
          return undefined;
        },
      );
    this.attachRoots.set(channel, asked);
    return asked;
  }

  /** askAttachRoot, but undefined once `deadline` passes. */
  private async askAttachRootBy(
    channel: AgentChannel,
    deadline: number,
  ): Promise<string | null | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), undefined);
    });
    try {
      return await Promise.race([this.askAttachRoot(channel), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The slots ("<tabId>/<n>") a conversation's whole history names, read by
   * the agent from the history kept in the profile's folder (a Claude
   * session) or home (a Codex thread): only their names come back. `found`
   * is false while the agent has no history of it yet (a fork's own, just
   * named): to be asked again. `truncated` tells that it names more than
   * these. None from an agent too old to tell, nor in
   * a profile since removed: a tab outlives its profile, and no history is
   * read there.
   */
  async historySlots(
    workspaceId: string,
    agent: ChatAgent,
    conversation: string,
    profileId?: string,
  ): Promise<{ slots: string[]; found: boolean; truncated: boolean }> {
    let where: Record<string, string>;
    try {
      if (agent === "claude") {
        where = { sessionId: conversation, ...this.configDir(workspaceId, profileId) };
      } else {
        const codexHome = this.profileDir(workspaceId, "codex", profileId);
        where = { threadId: conversation, ...(codexHome ? { codexHome } : {}) };
      }
    } catch (error) {
      if (error instanceof AgentProfileSelectionError)
        return { slots: [], found: true, truncated: false };
      throw error;
    }
    const channel = await this.channelFor(workspaceId);
    const result = await channel
      .call<{ slots?: unknown; found?: unknown; truncated?: unknown }>("chat.historySlots", {
        workspaceId,
        ...where,
      })
      .catch((error: unknown) => {
        if ((error as { code?: unknown } | null)?.code === "unsupported-method") return null;
        throw error;
      });
    const told = Array.isArray(result?.slots) ? result.slots : [];
    const slots = told.filter(
      (slot): slot is string => typeof slot === "string" && slot.length <= 300,
    );
    return {
      slots: slots.slice(-5_000),
      found: result?.found !== false,
      truncated: result?.truncated === true || slots.length > 5_000,
    };
  }

  async transcript(workspaceId: string, sessionId: string, profileId?: string): Promise<unknown> {
    const config = this.configDir(workspaceId, profileId);
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.transcript", {
      sessionId,
      ...config,
    });
  }

  async transcriptPage(
    workspaceId: string,
    sessionId: string,
    profileId: string | undefined,
    page: { cursor?: string; beforeAnchor?: string; upTo?: string; before?: string[] },
  ): Promise<TranscriptPageResult> {
    const args = { sessionId, ...this.configDir(workspaceId, profileId) };
    const channel = await this.channelFor(workspaceId);
    try {
      return await channel.call<TranscriptPageResult>("chat.transcriptPage", { ...args, ...page });
    } catch (error) {
      if (page.cursor || (error as { code?: unknown } | null)?.code !== "unsupported-method") {
        throw error;
      }
      const result = await channel.call<
        Pick<TranscriptPageResult, "found" | "lines" | "truncated">
      >("chat.transcript", args);
      // The renderer applies its cut to the old agent's unpaged result.
      return {
        found: result.found === true,
        lines: result.lines ?? [],
        truncated: result.truncated === true,
      };
    }
  }

  /**
   * The end of a chat's history, for a glance at its last turns: a Claude
   * transcript's last page, or a Codex rollout's last events, which the
   * agent reads from the file (no app-server). Read only from an agent that
   * is up: an SSH or WSL host that is not connected is not dialed, and is
   * told `offline`. An agent too old to read it gives neither.
   */
  async peekTail(
    workspaceId: string,
    agent: ChatAgent,
    sessionId: string,
    profileId: string | undefined,
    page: { turns?: number; cursor?: string } = {},
  ): Promise<ChatPeekTail> {
    const channel = await this.options.workspaceManager.peekAgentChannel?.(workspaceId);
    if (!channel) return { offline: true };
    await channel.ready;
    try {
      if (agent === "claude") {
        const claude = await channel.call<TranscriptPageResult>("chat.transcriptPage", {
          sessionId,
          ...this.configDir(workspaceId, profileId),
          ...(page.cursor ? { cursor: page.cursor } : {}),
        });
        return { offline: false, claude };
      }
      const codexHome = this.profileDir(workspaceId, "codex", profileId);
      const codex = await channel.call<NonNullable<ChatPeekTail["codex"]>>("chat.rolloutTail", {
        threadId: sessionId,
        ...(codexHome ? { codexHome } : {}),
        ...(page.turns ? { turns: page.turns } : {}),
      });
      return { offline: false, codex };
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "unsupported-method") {
        return { offline: false };
      }
      throw error;
    }
  }

  /**
   * The transcript of the tab's `claude -p` run `runId`, read on from
   * `from` (where the last read ended): read where the run's own start
   * said its session is kept, never where the renderer says. Not found for
   * a run not of that tab, a `codex exec` run, or one that keeps none.
   */
  async printRunTranscript(
    workspaceId: string,
    tabId: string,
    runId: string,
    from: number | undefined,
  ): Promise<PrintRunTranscriptResult> {
    const none: PrintRunTranscriptResult = {
      found: false,
      lines: [],
      next: 0,
      reset: false,
      truncated: false,
    };
    const source = this.options.printRunSource?.(workspaceId, tabId, runId);
    if (source?.program !== "claude" || !source.sessionId || !source.home) return none;
    const channel = await this.channelFor(workspaceId);
    try {
      const result = await channel.call<{
        found?: boolean;
        lines?: unknown[];
        next?: number;
        reset?: boolean;
        truncated?: boolean;
      }>("chat.runTranscript", {
        sessionId: source.sessionId,
        configDir: source.home,
        ...(from !== undefined ? { from } : {}),
      });
      return {
        found: result.found === true,
        lines: result.lines ?? [],
        next: typeof result.next === "number" ? result.next : 0,
        reset: result.reset === true,
        truncated: result.truncated === true,
      };
    } catch (error) {
      // An agent before chat.runTranscript: the pane shows what the run told.
      if ((error as { code?: unknown } | null)?.code === "unsupported-method") return none;
      throw error;
    }
  }

  /**
   * Starts a Codex app-server that reads the tab's `codex exec` run
   * `runId`'s thread, with the run's own CODEX_HOME, as a tab's starts (an
   * SSH or WSL host's too): its lines come as a chat tab's do, by the
   * reader's tab id, which chat.close ends. Send lets it be told only reads.
   */
  async startPrintRunReader(
    workspaceId: string,
    tabId: string,
    runId: string,
  ): Promise<PrintRunReaderResult> {
    const source = this.options.printRunSource?.(workspaceId, tabId, runId);
    if (source?.program !== "codex" || !source.sessionId || !source.home) {
      return { ok: false, reason: "none" };
    }
    const readerTabId = `${PRINT_RUN_READER_PREFIX}${randomUUID()}`;
    const key = `${workspaceId}:${readerTabId}`;
    const intent = this.openTab(key);
    try {
      const channel = await this.channelForStart(workspaceId, key, intent);
      const windows = this.windowsHost(workspaceId);
      const profileEnv = mergeAgentEnv(
        windows,
        await this.profileEnv(channel, this.profile("codex", undefined), windows),
        { [PROFILE_DIR_ENV.codex]: source.home },
      );
      const cwd = source.cwd ?? source.home;
      const found = await this.findBinary(channel, "codex", cwd, profileEnv, windows);
      if (!found.path) {
        this.tabIntents.delete(key);
        return { ok: false, reason: "not-found" };
      }
      const path = agentEnvValue(profileEnv, "PATH", windows) ?? found.envPath;
      await this.spawn(key, intent, channel, {
        workspaceId,
        tabId: readerTabId,
        cwd,
        program: found.path,
        args: ["app-server"],
        env: mergeAgentEnv(windows, profileEnv, path === undefined ? {} : { PATH: path }),
        resetLog: true,
      });
      return { ok: true, readerTabId, threadId: source.sessionId };
    } catch (error) {
      void this.closeTab(workspaceId, readerTabId).catch(() => {});
      return { ok: false, reason: "failed", message: (error as Error).message };
    }
  }

  async subagentTranscript(
    workspaceId: string,
    sessionId: string,
    agent: { agentId?: string; toolUseId?: string },
    profileId?: string,
  ): Promise<unknown> {
    const config = this.configDir(workspaceId, profileId);
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.subagentTranscript", {
      sessionId,
      ...agent,
      ...config,
    });
  }

  async sessionFile(workspaceId: string, sessionId: string, profileId?: string): Promise<unknown> {
    const config = this.configDir(workspaceId, profileId);
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.sessionFile", {
      sessionId,
      ...config,
    });
  }

  async stageThread(
    workspaceId: string,
    threadId: string,
    options: { fromProfileId?: string; toProfileId?: string },
  ): Promise<unknown> {
    const from = this.profileDir(workspaceId, "codex", options.fromProfileId);
    const to = this.profileDir(workspaceId, "codex", options.toProfileId);
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.stageThread", {
      threadId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }

  async claudeConfig(workspaceId: string, profileId?: string): Promise<unknown> {
    const config = this.configDir(workspaceId, profileId);
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.claudeConfig", config);
  }

  /** Runs one of the `claude` commands a tab may (`claude agents`, `claude plugin`…) in the folder. */
  async cli(
    workspaceId: string,
    cwd: string,
    command: ClaudeCommand,
    profileId?: string,
  ): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
    const profile = this.profile("claude", profileId);
    const channel = await this.channelFor(workspaceId);
    const windows = this.windowsHost(workspaceId);
    const env = await this.profileEnv(channel, profile, windows);
    const found = await this.findBinary(channel, "claude", cwd, env, windows);
    if (!found.path) throw new Error("claude was not found on the PATH");
    return channel.call(
      "chat.exec",
      {
        cwd,
        program: found.path,
        args: claudeCommandArgs(command, cwd),
        env: mergeAgentEnv(windows, found.envPath ? { PATH: found.envPath } : {}, env),
        timeoutMs: COMMAND_TIMEOUT_MS,
      },
      { timeoutMs: COMMAND_REPLY_TIMEOUT_MS },
    );
  }

  async sessions(workspaceId: string, cwd: string, profileId?: string): Promise<unknown> {
    const config = this.configDir(workspaceId, profileId);
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.sessions", { cwd, ...config });
  }

  async deleteSession(
    workspaceId: string,
    cwd: string,
    sessionId: string,
    profileId?: string,
  ): Promise<unknown> {
    const config = this.configDir(workspaceId, profileId);
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.deleteSession", {
      cwd,
      sessionId,
      ...config,
    });
  }

  async fileSizes(workspaceId: string, paths: readonly string[]): Promise<unknown> {
    const channel = await this.channelFor(workspaceId);
    return channel.call("chat.fileSizes", { paths });
  }

  /** Only workspaces on this Windows machine use case-insensitive environment names. */
  private windowsHost(workspaceId: string): boolean {
    return (
      (process.platform === "win32" || this.options.windowsAgentFiles !== undefined) &&
      this.options.workspaceManager.isLocal?.(workspaceId) === true
    );
  }

  /** Selects the same executable for the probe and for launching the provider. */
  private findBinary(
    channel: AgentChannel,
    agent: ChatAgent,
    cwd: string,
    env: Record<string, string>,
    windows: boolean,
  ): Promise<{ path: string; envPath?: string }> {
    const searchPath = agentEnvValue(env, "PATH", windows);
    return channel.call("lsp.findBinary", {
      name: agent,
      dir: cwd,
      ...(searchPath ? { searchPath } : {}),
    });
  }

  /** Probes the selected executable in its profile's environment before adding launch flags. */
  private async probeVersion(
    channel: AgentChannel,
    agent: ChatAgent,
    cwd: string,
    program: string,
    env: Record<string, string>,
  ): Promise<string | null> {
    try {
      const run = await channel.call<{ code: number; stdout: string }>("chat.exec", {
        cwd,
        program,
        args: ["--version"],
        env,
        timeoutMs: VERSION_TIMEOUT_MS,
      });
      return run.code === 0 ? parseClaudeVersion(run.stdout) : null;
    } catch (error) {
      log.warn(`${agent} --version failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** Rejects explicit stale choices and resolves omitted IDs to the stored default. */
  private profile(agent: ChatAgent, profileId: string | undefined): AgentProfile {
    const id = profileId ?? defaultProfileId(agent);
    const profile = this.options.profile?.(id);
    if (profile?.agent === agent) return profile;
    if (!profile && id === defaultProfileId(agent)) {
      return { id, agent, dir: "", name: "", color: "" };
    }
    const error = new AgentProfileSelectionError(
      profile || id === defaultProfileId(agent === "claude" ? "codex" : "claude")
        ? `Profile ${id} does not belong to ${agent}`
        : `Profile ${id} was not found`,
    );
    log.warn(error.message);
    throw error;
  }

  /** A running tab can outlive its profile. Deleted profiles have no layer. */
  private instructionProfile(agent: ChatAgent, profileId: string | undefined): AgentProfile {
    const id = profileId ?? defaultProfileId(agent);
    const profile = this.options.profile?.(id);
    return profile?.agent === agent ? profile : { id, agent, dir: "", name: "", color: "" };
  }

  /** Selects the same folder when reading history as when starting a profile. */
  private profileDir(workspaceId: string, agent: ChatAgent, profileId: string | undefined): string {
    return profileDirectory(this.profile(agent, profileId), this.windowsHost(workspaceId));
  }

  /** The Claude profile's folder, as the agent's readers take it. */
  private configDir(workspaceId: string, profileId: string | undefined): { configDir?: string } {
    const configDir = this.profileDir(workspaceId, "claude", profileId);
    return configDir ? { configDir } : {};
  }

  /** A terminal in an agent profile uses the same variables and folder as its chat. */
  async terminalProfileEnv(
    workspaceId: string,
    profileId: string | undefined,
    defaultAgent: ChatAgent = "claude",
  ): Promise<Record<string, string> | null> {
    const profile =
      profileId === undefined
        ? this.profile(defaultAgent, undefined)
        : this.options.profile?.(profileId);
    if (!profile) {
      log.warn(`Profile ${profileId} was not found for terminal spawn`);
      return null;
    }
    const channel = await this.options.workspaceManager.getAgentChannel(workspaceId);
    await channel.ready;
    return this.profileEnv(channel, profile, this.windowsHost(workspaceId));
  }

  /** Prepares named profile folders on the workspace host and overlays their directory variable. */
  private async profileEnv(
    channel: AgentChannel,
    profile: AgentProfile,
    windows: boolean,
    requireApiKey = false,
  ): Promise<Record<string, string>> {
    const { agent } = profile;
    const key = PROFILE_DIR_ENV[agent];
    const connection = agent === "claude" ? profile.connection : undefined;
    const apiKey =
      connection && connection.method !== "account"
        ? await this.profileConnectionKey(profile)
        : undefined;
    if (requireApiKey && connection?.method === "api-key" && !apiKey)
      throw new Error(missingApiKeyMessage());
    const env = mergeAgentEnv(
      windows,
      profileVariables(profile.env, windows),
      claudeConnectionEnv(connection, apiKey),
    );
    let dir = profileDirectory(profile, windows);
    if (profile.dir.trim() !== "") {
      const result = await channel.call<{ dir: string; failed?: string[] }>("chat.profileDir", {
        agent,
        dir,
        shared: profile.shared ?? [],
        shareable: SHAREABLE[agent],
      });
      if (result.failed && result.failed.length > 0) {
        log.warn(`profile ${profile.id}: could not link ${result.failed.join(", ")}`);
      }
      dir = result.dir;
    }
    if (!dir) {
      return Object.fromEntries(
        Object.entries(env).filter(([name]) => (windows ? name.toUpperCase() : name) !== key),
      );
    }
    return mergeAgentEnv(windows, env, { [key]: dir });
  }

  private profileConnectionKey(profile: AgentProfile): Promise<string | undefined> | undefined {
    if (!profile.connection || profile.connection.method === "account") return;
    return this.options.connectionKey?.(
      profile.id,
      connectionKeyTarget(profile.agent, profile.connection),
    );
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
    // Read while the workspace is still known.
    const host = this.options.workspaceManager.attachHost?.(workspaceId) ?? null;
    const deadline = Date.now() + WORKSPACE_CHAT_CLOSE_MS;
    if (tabIds.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("chat.close timed out")),
          WORKSPACE_CHAT_CLOSE_MS,
        );
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
    // Its closed tabs' files stayed for conversations of its own, which go with it.
    await this.removeWorkspaceAttachments(workspaceId, channel, host, deadline);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.oauth.dispose();
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
    // A run's reader is no tab: it has no status.
    if (!tabId || isPrintRunReader(tabId)) return;
    if (event === "exit") {
      // A restart's new file is not the exited program's.
      const key = `${workspaceId}:${tabId}`;
      if (!this.promptStarting.has(key)) void this.removePromptFile(key);
      this.options.onProgramExit?.(workspaceId, tabId);
      return;
    }
    if (payload.dir !== "out") return;
    const message = payload.message as Record<string, unknown> | null | undefined;
    if (
      message?.type === "system" &&
      (message.subtype === "task_started" || message.subtype === "task_notification")
    ) {
      this.options.onTaskEvent?.(workspaceId, tabId, message);
      return;
    }
    if (payload.replay === true || message?.type !== "result") return;
    this.options.onTurnResult?.(workspaceId, tabId, claudeTurnResult(message));
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
