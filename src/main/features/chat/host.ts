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
import { isPrintRunReader, PRINT_RUN_READER_PREFIX } from "../../../shared/chat/print-run-reader";
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

const VERSION_TIMEOUT_MS = 20_000;
const CUSTOM_CLAUDE_FROM = "2.1.242";

function missingApiKeyMessage(): string {
  return (
    tryGetMainT()?.("settings:profiles.connection.errors.missingKey") ??
    "Set the profile API key in Settings."
  );
}
const WORKSPACE_CHAT_CLOSE_MS = 5000;
const COMMAND_TIMEOUT_MS = 30_000;
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
  peekAgentChannel?(workspaceId: string): Promise<AgentChannel | null>;
  attachHost?(workspaceId: string): string | null;
}

export const ATTACH_UNUSED_MS = 30 * 24 * 60 * 60 * 1000;
const UNNAMED_SCAN_TIMEOUT_MS = 10 * 60 * 1000;
export const ATTACH_ROOM_BYTES = 1024 * 1024 * 1024;

function namedRoot(root: unknown): string | null {
  if (typeof root !== "string" || root === "") return null;
  return /^[\\/]{2}/.test(root) ? null : root;
}

export interface AttachCleanups {
  add(host: string, workspaceId: string): void;
  waiting(host: string): string[];
  remove(host: string, workspaceId: string): void;
}

const PRINT_RUN_READERS = 2;

const PRINT_RUN_READER_METHODS = new Set([
  "initialize",
  "initialized",
  "thread/read",
  "thread/turns/list",
]);
const PRINT_RUN_READER_THREAD_METHODS = new Set(["thread/read", "thread/turns/list"]);

interface PrintRunReader {
  workspaceId: string;
  ownerTabId: string;
  threadId: string;
  opener?: number;
}

function readerRefused(message: string): Error {
  return Object.assign(new Error(message), { code: "chat.reader-read-only" });
}

export interface ChatHostOptions {
  workspaceManager: ChatWorkspaceManager;
  broadcast: (event: string, args: unknown) => void;
  windowsAgentFiles?: () => Promise<WindowsAgentFiles | null>;
  promptFiles?: PromptFiles;
  onTurnResult?: (workspaceId: string, tabId: string, result: ClaudeTurnResult) => void;
  onTaskEvent?: (workspaceId: string, tabId: string, message: Record<string, unknown>) => void;
  printRunSource?: (
    workspaceId: string,
    tabId: string,
    runId: string,
  ) => PrintRunSource | undefined;
  onProgramExit?: (workspaceId: string, tabId: string) => void;
  knownChatTabs?: (workspaceId: string) => readonly string[];
  profile?: (id: string) => AgentProfile | null;
  profiles?: () => readonly AgentProfile[];
  connectionKey?: (id: string, target: string | undefined) => Promise<string | undefined>;
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
  attachCleanups?: AttachCleanups;
}

export type StartResult =
  | { ok: true; pid: number; attached: boolean; version: string | null; canonicalCwd?: string }
  | { ok: false; reason: "not-found" | "failed"; message: string };

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

interface Launch {
  key: string;
  intent: TabIntent;
  channel: AgentChannel;
  profile: AgentProfile;
  windows: boolean;
  apiKey: string | undefined;
  profileEnv: Record<string, string>;
  program: string;
  path: string | undefined;
  env: Record<string, string>;
  version: string | null;
}

type PreparedLaunch =
  | ({ ok: true } & Launch)
  | { ok: false; reason: "not-found" | "failed"; message: string };

function launchConnectionEnv(
  profile: AgentProfile,
  apiKey: string | undefined,
): Record<string, string> {
  return profile.agent === "claude"
    ? claudeConnectionEnv(profile.connection, apiKey)
    : codexConnectionEnv(profile.connection, apiKey);
}

interface WorkspaceChatClose {
  readonly channel: AgentChannel | null;
  readonly deadline: number;
  readonly expired: Promise<never>;
}

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
  private readonly codexProfiles = new Map<string, string>();
  private readonly promptFiles = new Map<string, string>();
  private readonly promptStarting = new Set<string>();
  private readonly closingTabs = new Map<string, Promise<unknown>>();
  private readonly printRunReaders = new Map<string, PrintRunReader>();
  private readonly workspaces = new Set<string>();
  private readonly attachRoots = new WeakMap<AgentChannel, Promise<string | null | undefined>>();
  private readonly disposeProviderReady: () => void;
  private disposed = false;

  constructor(private readonly options: ChatHostOptions) {
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
    const launch = await this.prepareLaunch("claude", workspaceId, tabId, cwd, { profileId });
    if (!launch.ok) return launch;
    const { key, intent, channel, profile, windows, profileEnv, path, version } = launch;
    const { program: claude, env: launchEnv } = launch;
    const { workspaceManager } = this.options;
    const withoutWrapper = windows && this.options.windowsAgentFiles !== undefined;

    if (resume.usageOnly) {
      try {
        const result = await this.spawn(key, intent, channel, {
          workspaceId,
          tabId,
          cwd,
          program: claude,
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
    let program = claude;
    let agentFiles: WindowsAgentFiles | null | undefined;
    let gitBash: { wrapperDir: string; bashEnv: string } | undefined;
    if (withoutWrapper) {
      agentFiles = await this.options.windowsAgentFiles?.();
      const shimDir = workspaceManager.getWrapperShimDir(workspaceId);
      if (agentFiles && shimDir !== null) {
        gitBash = { wrapperDir: agentFiles.binDir, bashEnv: hostJoin(shimDir, "bashenv", true) };
      }
    } else if (wrapperBinDir !== null) {
      program = hostJoin(wrapperBinDir, "claude", false);
    }
    try {
      await this.closingTabs.get(key);
      const hookInfo = await workspaceManager.getSpawnHookInfo(workspaceId, channel);
      const hooksSettings = hookInfo
        ? agentFiles?.settingsPath
        : agentFiles?.serverlessSettingsPath;
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
      if (program !== claude) env.NEXUS_CLAUDE_PROGRAM = claude;
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
        if (program !== claude) {
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
      if (result.attached === true) await this.removePromptFile(key);
      return { ok: true, pid: result.pid, attached: result.attached === true, version };
    } catch (err) {
      return { ok: false, reason: "failed", message: (err as Error).message };
    }
  }

  private async removePromptFile(key: string): Promise<void> {
    const file = this.promptFiles.get(key);
    if (file === undefined) return;
    this.promptFiles.delete(key);
    await this.options.promptFiles?.remove(file);
  }

  async startCodex(
    workspaceId: string,
    tabId: string,
    cwd: string,
    options: { resetLog?: boolean; connectionChanged?: boolean; profileId?: string },
  ): Promise<StartResult> {
    const launch = await this.prepareLaunch("codex", workspaceId, tabId, cwd, {
      profileId: options.profileId,
    });
    if (!launch.ok) return launch;
    const { key, intent, channel, profile, windows, apiKey, profileEnv, path, version } = launch;
    this.codexProfiles.set(key, profile.id);
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
        program: launch.program,
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

  private async prepareLaunch(
    agent: ChatAgent,
    workspaceId: string,
    tabId: string,
    cwd: string,
    options: { profileId?: string; home?: string; probeVersion?: boolean; connection?: boolean },
  ): Promise<PreparedLaunch> {
    let profile: AgentProfile;
    try {
      profile = this.profile(agent, options.profileId);
    } catch (error) {
      return { ok: false, reason: "failed", message: (error as Error).message };
    }
    const key = `${workspaceId}:${tabId}`;
    const intent = this.openTab(key);
    const channel = await this.channelForStart(workspaceId, key, intent);
    const windows = this.windowsHost(workspaceId);
    let apiKey: string | undefined;
    let profileEnv: Record<string, string>;
    try {
      if (options.connection !== false) {
        apiKey = await this.profileConnectionKey(profile);
        if (profile.connection?.method === "api-key" && !apiKey) {
          throw new Error(missingApiKeyMessage());
        }
      }
      profileEnv = await this.profileEnv(
        channel,
        profile,
        windows,
        options.connection === false ? {} : launchConnectionEnv(profile, apiKey),
      );
    } catch (error) {
      return { ok: false, reason: "failed", message: (error as Error).message };
    }
    if (options.home !== undefined) {
      profileEnv = mergeAgentEnv(windows, profileEnv, { [PROFILE_DIR_ENV[agent]]: options.home });
    }
    const found = await this.findBinary(channel, agent, cwd, profileEnv, windows);
    if (!found.path) {
      return { ok: false, reason: "not-found", message: `${agent} was not found on the PATH` };
    }
    const path = agentEnvValue(profileEnv, "PATH", windows) ?? found.envPath;
    const env = mergeAgentEnv(windows, profileEnv, path === undefined ? {} : { PATH: path });
    const version =
      options.probeVersion === false
        ? null
        : await this.probeVersion(channel, agent, cwd, found.path, env);
    return {
      ok: true,
      key,
      intent,
      channel,
      profile,
      windows,
      apiKey,
      profileEnv,
      program: found.path,
      path,
      env,
      version,
    };
  }

  private openTab(key: string): TabIntent {
    const known = this.tabIntents.get(key);
    if (known) return known;
    const intent = { generation: randomUUID(), starts: new Set<Promise<unknown>>() };
    this.tabIntents.set(key, intent);
    return intent;
  }

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

  private async closeTab(
    workspaceId: string,
    tabId: string,
    removal?: WorkspaceChatClose,
  ): Promise<unknown> {
    const key = `${workspaceId}:${tabId}`;
    if (isPrintRunReader(tabId)) this.printRunReaders.delete(tabId);
    else this.closePrintRunReaders(workspaceId, tabId);
    const intent = this.tabIntents.get(key);
    const previous = this.closingTabs.get(key);
    if (previous && !intent && !removal) return previous;
    this.tabIntents.delete(key);
    this.claudeInstructions.delete(key);
    this.codexProfiles.delete(key);
    this.claudeInstructionUpdates.delete(key);
    const close = async () => {
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
        const timeoutMs = removal.deadline - Date.now();
        if (timeoutMs <= 0) return removal.expired;
        return removal.channel.call("chat.close", params, { timeoutMs });
      }
      const channel = isPrintRunReader(tabId)
        ? ((await this.options.workspaceManager.peekAgentChannel?.(workspaceId)) ?? null)
        : await this.options.workspaceManager.tryGetAgentChannel(workspaceId);
      if (!channel) return undefined;
      const kept = (await this.askAttachRoot(channel)) !== null;
      return channel.call("chat.close", { ...params, ...(kept ? { keepAttachments: true } : {}) });
    };
    const run = (async () => {
      try {
        return await (removal ? Promise.race([close(), removal.expired]) : close());
      } finally {
        this.subscriptions.get(workspaceId)?.processes.delete(tabId);
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
    if (isPrintRunReader(tabId)) {
      await this.sendToPrintRunReader(workspaceId, tabId, message);
      return;
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
      if (sessionId && fork && sessionId !== fork.sessionId && previous === undefined)
        remember(fork.digest);
      return "";
    }
    const restoring = hook.phase === "restore";
    const profile = this.instructionProfile("claude", layer.profileId);
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
      if (!capOnly) await channel.call("chat.pruneAttachments", { workspaceId, keepTabIds });
      return;
    }
    if (!keepSlots) return;
    await this.removeWaitingAttachments(workspaceId, channel);
    await channel.call("chat.pruneAttachments", {
      workspaceId,
      keepTabIds,
      retain: {
        keep: keepSlots,
        maxAgeMs: capOnly ? 0 : ATTACH_UNUSED_MS,
        maxBytes: ATTACH_ROOM_BYTES,
      },
    });
  }

  async attachmentCall(
    method: "touchAttachments",
    args: { workspaceId: string; slots: string[] },
  ): Promise<void> {
    if (args.slots.length === 0) return;
    const channel = await this.channelFor(args.workspaceId);
    await channel.call(`chat.${method}`, args).catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code !== "unsupported-method") throw error;
    });
  }

  async removeConversationAttachments({
    workspaceId,
    slots,
    exceptThread,
  }: {
    workspaceId: string;
    slots: string[];
    exceptThread?: { threadId: string; profileId?: string };
  }): Promise<void> {
    if (slots.length === 0) return;
    const except = exceptThread
      ? {
          exceptThreadId: exceptThread.threadId,
          exceptCodexHome: this.profileDir(workspaceId, "codex", exceptThread.profileId),
        }
      : {};
    const params = {
      workspaceId,
      slots,
      claudeDirs: this.profileDirs(workspaceId, "claude"),
      codexHomes: this.profileDirs(workspaceId, "codex"),
      ...except,
    };
    const channel = await this.channelFor(workspaceId);
    await channel
      .call("chat.removeUnnamedAttachments", params, { timeoutMs: UNNAMED_SCAN_TIMEOUT_MS })
      .catch((error: unknown) => {
        if ((error as { code?: unknown } | null)?.code !== "unsupported-method") throw error;
      });
  }

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
        if ((error as { code?: unknown } | null)?.code !== "unsupported-method") {
          log.warn(
            `could not remove removed workspace ${removed}'s attached files: ${String(error)}`,
          );
          continue;
        }
      }
      cleanups.remove(host, removed);
    }
  }

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
      if ((error as { code?: unknown } | null)?.code === "unsupported-method") return;
      log.warn(
        `could not remove removed workspace ${workspaceId}'s attached files: ${String(error)}`,
      );
      wait();
    }
  }

  async attachRoot(workspaceId: string): Promise<string | null> {
    const channel = await this.options.workspaceManager
      .peekAgentChannel?.(workspaceId)
      .catch(() => null);
    if (!channel) return null;
    return (await this.askAttachRoot(channel)) ?? null;
  }

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
      return {
        found: result.found === true,
        lines: result.lines ?? [],
        truncated: result.truncated === true,
      };
    }
  }

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
    const channel = await this.upChannel(workspaceId);
    if (!channel) return none;
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
      if ((error as { code?: unknown } | null)?.code === "unsupported-method") return none;
      throw error;
    }
  }

  private async upChannel(workspaceId: string): Promise<AgentChannel | null> {
    const channel = await this.options.workspaceManager.peekAgentChannel?.(workspaceId);
    if (!channel) return null;
    await channel.ready;
    this.workspaces.add(workspaceId);
    this.subscribe(workspaceId, channel);
    return channel;
  }

  async startPrintRunReader(
    workspaceId: string,
    tabId: string,
    runId: string,
    opener?: number,
  ): Promise<PrintRunReaderResult> {
    const source = this.options.printRunSource?.(workspaceId, tabId, runId);
    if (source?.program !== "codex" || !source.sessionId || !source.home) {
      return { ok: false, reason: "none" };
    }
    if (this.disposed || !this.tabIntents.has(`${workspaceId}:${tabId}`)) {
      return { ok: false, reason: "none" };
    }
    if (!(await this.upChannel(workspaceId))) return { ok: false, reason: "none" };
    const readerTabId = `${PRINT_RUN_READER_PREFIX}${randomUUID()}`;
    const up = [...this.printRunReaders].filter(
      ([, reader]) => reader.workspaceId === workspaceId && reader.ownerTabId === tabId,
    );
    for (const [old] of up.slice(0, Math.max(0, up.length + 1 - PRINT_RUN_READERS))) {
      void this.closeTab(workspaceId, old).catch(() => {});
    }
    this.printRunReaders.set(readerTabId, {
      workspaceId,
      ownerTabId: tabId,
      threadId: source.sessionId,
      ...(opener !== undefined ? { opener } : {}),
    });
    const cwd = source.cwd ?? source.home;
    const remembered = this.codexProfiles.get(`${workspaceId}:${tabId}`);
    try {
      const launch = await this.prepareLaunch("codex", workspaceId, readerTabId, cwd, {
        profileId: remembered && this.options.profile?.(remembered) ? remembered : undefined,
        home: source.home,
        probeVersion: false,
        connection: false,
      });
      if (!launch.ok && launch.reason === "not-found") {
        this.tabIntents.delete(`${workspaceId}:${readerTabId}`);
        this.printRunReaders.delete(readerTabId);
        return { ok: false, reason: "not-found" };
      }
      if (!launch.ok) throw new Error(launch.message);
      await this.spawn(launch.key, launch.intent, launch.channel, {
        workspaceId,
        tabId: readerTabId,
        cwd,
        program: launch.program,
        args: ["app-server"],
        env: launch.env,
        resetLog: true,
      });
      return { ok: true, readerTabId };
    } catch (error) {
      void this.closeTab(workspaceId, readerTabId).catch(() => {});
      return { ok: false, reason: "failed", message: (error as Error).message };
    }
  }

  private async sendToPrintRunReader(
    workspaceId: string,
    readerTabId: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    const reader = this.printRunReaders.get(readerTabId);
    if (!reader || reader.workspaceId !== workspaceId) throw readerRefused("no such reader");
    const { method, id } = message;
    if (typeof method !== "string" || !PRINT_RUN_READER_METHODS.has(method)) {
      throw readerRefused("a run's reader only reads");
    }
    if (id !== undefined && typeof id !== "number" && typeof id !== "string") {
      throw readerRefused("a run's reader only reads");
    }
    const given = message.params;
    if (
      given !== undefined &&
      (typeof given !== "object" || given === null || Array.isArray(given))
    ) {
      throw readerRefused("a run's reader only reads");
    }
    let params = given as Record<string, unknown> | undefined;
    if (PRINT_RUN_READER_THREAD_METHODS.has(method)) {
      const named = params?.threadId;
      if (named !== undefined && named !== reader.threadId) {
        throw readerRefused("a run's reader reads its own run only");
      }
      params = { ...params, threadId: reader.threadId };
    }
    const channel = await this.upChannel(workspaceId);
    if (!channel) throw readerRefused("the reader's host is out of reach");
    await channel.call("chat.send", {
      workspaceId,
      tabId: readerTabId,
      message: {
        ...(id !== undefined ? { id } : {}),
        method,
        ...(params !== undefined ? { params } : {}),
      },
    });
  }

  closePrintRunReaders(workspaceId?: string, tabId?: string): void {
    for (const [readerTabId, reader] of [...this.printRunReaders]) {
      if (workspaceId !== undefined && reader.workspaceId !== workspaceId) continue;
      if (tabId !== undefined && reader.ownerTabId !== tabId) continue;
      void this.closeTab(reader.workspaceId, readerTabId).catch(() => {});
    }
  }

  closePrintRunReadersOf(opener: number): void {
    for (const [readerTabId, reader] of [...this.printRunReaders]) {
      if (reader.opener !== opener) continue;
      void this.closeTab(reader.workspaceId, readerTabId).catch(() => {});
    }
  }

  private async prunePrintRunReaders(workspaceId: string, channel: AgentChannel): Promise<void> {
    try {
      const listed = await channel.call<{ sessions?: { tabId?: unknown }[] }>("chat.list", {
        workspaceId,
      });
      for (const session of listed.sessions ?? []) {
        const tabId = session.tabId;
        if (typeof tabId !== "string" || !isPrintRunReader(tabId)) continue;
        if (this.printRunReaders.has(tabId)) continue;
        await channel.call("chat.close", { workspaceId, tabId }).catch(() => {});
      }
    } catch (error) {
      log.warn(`could not list ${workspaceId}'s run readers: ${(error as Error).message}`);
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

  async cli(
    workspaceId: string,
    cwd: string,
    command: ClaudeCommand,
    profileId?: string,
  ): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
    const profile = this.profile("claude", profileId);
    const channel = await this.channelFor(workspaceId);
    const windows = this.windowsHost(workspaceId);
    const env = await this.commandEnv(channel, profile, windows);
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

  private windowsHost(workspaceId: string): boolean {
    return (
      (process.platform === "win32" || this.options.windowsAgentFiles !== undefined) &&
      this.options.workspaceManager.isLocal?.(workspaceId) === true
    );
  }

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

  private instructionProfile(agent: ChatAgent, profileId: string | undefined): AgentProfile {
    const id = profileId ?? defaultProfileId(agent);
    const profile = this.options.profile?.(id);
    return profile?.agent === agent ? profile : { id, agent, dir: "", name: "", color: "" };
  }

  private profileDir(workspaceId: string, agent: ChatAgent, profileId: string | undefined): string {
    return profileDirectory(this.profile(agent, profileId), this.windowsHost(workspaceId));
  }

  private profileDirs(workspaceId: string, agent: ChatAgent): string[] {
    const windows = this.windowsHost(workspaceId);
    const listed = (this.options.profiles?.() ?? []).filter((profile) => profile.agent === agent);
    const profiles = listed.length > 0 ? listed : [this.instructionProfile(agent, undefined)];
    return [...new Set(profiles.map((profile) => profileDirectory(profile, windows)))];
  }

  private configDir(workspaceId: string, profileId: string | undefined): { configDir?: string } {
    const configDir = this.profileDir(workspaceId, "claude", profileId);
    return configDir ? { configDir } : {};
  }

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
    return this.commandEnv(channel, profile, this.windowsHost(workspaceId));
  }

  private async commandEnv(
    channel: AgentChannel,
    profile: AgentProfile,
    windows: boolean,
  ): Promise<Record<string, string>> {
    const connectionEnv =
      profile.agent === "claude"
        ? claudeConnectionEnv(profile.connection, await this.profileConnectionKey(profile))
        : {};
    return this.profileEnv(channel, profile, windows, connectionEnv);
  }

  private async profileEnv(
    channel: AgentChannel,
    profile: AgentProfile,
    windows: boolean,
    connectionEnv: Record<string, string>,
  ): Promise<Record<string, string>> {
    const { agent } = profile;
    const key = PROFILE_DIR_ENV[agent];
    const env = mergeAgentEnv(windows, profileVariables(profile.env, windows), connectionEnv);
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
    await this.removeWorkspaceAttachments(workspaceId, channel, host, deadline);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [readerTabId, reader] of this.printRunReaders) {
      const channel = this.subscriptions.get(reader.workspaceId)?.channel;
      void channel
        ?.call("chat.close", { workspaceId: reader.workspaceId, tabId: readerTabId })
        .catch(() => {});
    }
    this.printRunReaders.clear();
    this.oauth.dispose();
    this.disposeProviderReady();
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
    this.workspaces.clear();
    this.tabIntents.clear();
  }

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

  private noteForStatus(event: string, payload: Record<string, unknown>): void {
    const workspaceId = payload.workspaceId as string;
    const tabId = typeof payload.tabId === "string" ? payload.tabId : null;
    if (!tabId) return;
    if (isPrintRunReader(tabId)) {
      if (event === "exit") {
        this.printRunReaders.delete(tabId);
        this.tabIntents.delete(`${workspaceId}:${tabId}`);
      }
      return;
    }
    if (event === "exit") {
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

  private subscribe(workspaceId: string, channel: AgentChannel): void {
    const existing = this.subscriptions.get(workspaceId);
    if (existing?.channel === channel || this.disposed) return;
    existing?.dispose();

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
    void this.prunePrintRunReaders(workspaceId, channel);
  }

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
