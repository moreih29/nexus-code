import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { BrowserWindow } from "electron";
import type { AgentRun, PermissionAnswer, PermissionAsk } from "../../../shared/claude/activity";
import {
  CliCancelSchema,
  type CliInvocation,
  CliRequestRefSchema,
  CliRequestSchema,
  type CliResult,
} from "../../../shared/cli/protocol";
import type { CliUiOp, CliUiOps } from "../../../shared/cli/ui";
import { FS_READ_ABSOLUTE_BINARY_METHOD } from "../../../shared/fs/protocol";
import { FileReadBinaryResultSchema, FsStatSchema } from "../../../shared/fs/types";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcErr, ipcOk } from "../../../shared/ipc/result";
import { limitLog, safeText } from "../../../shared/log/limit";
import { createLogger } from "../../../shared/log/main";
import { redactLogSecrets } from "../../../shared/log/redact-secrets";
import type { ListeningPort } from "../../../shared/pty/ports";
import type { WorkspaceLocation, WorkspaceMeta } from "../../../shared/types/workspace";
import type { WorkspaceColor } from "../../../shared/types/workspace-color";
import { shortId } from "../../../shared/util/short-id";
import { tryGetMainT } from "../../i18n";
import type { AgentChannel } from "../../infra/agent/channel";
import { register, validateArgs } from "../../infra/ipc-router";
import { getBrowserRegistry, onBrowserTabCreated } from "../browser";
import type { ActiveContextStore } from "../claude/active-context";
import type { ClaudeStatusBroker } from "../claude/status";
import { type ActivitySource, ActivityTracker } from "./activity";
import { CdpBrowserDriver } from "./browser/driver";
import { formatPick, type PickedElement } from "./browser/pick";
import { savePickPicture } from "./browser/pick-pictures";
import { ClaudeExitWatch } from "./claude-exit";
import { CLI_COMMANDS } from "./commands";
import {
  type ChatAgentContext,
  chatAgentContext,
  linkedNoteGuidance,
} from "./commands/agent-context";
import {
  type ChangeRequest,
  CrossWorkspaceConsent,
  type CrossWorkspacePolicy,
  consentArgsForChange,
  grantWorkspaceId,
} from "./consent";
import { ConsentPrompts } from "./consent-prompts";
import {
  type CliCaller,
  CliError,
  type CliForwards,
  type CliNotes,
  type CliRemote,
  type CliServices,
} from "./context";
import { listedAt } from "./listed";
import { notifyTab } from "./notifier";
import { commandName, commandWaits, runCli } from "./registry";
import { RendererBridge } from "./renderer-bridge";
import { SessionsRevisions } from "./sessions-revisions";
import { noteSlowRequest } from "./slow-log";
import { StartedAgents } from "./started-agents";
import { WaitRegistry } from "./waits";

const log = createLogger("cli");
const slowRequests = limitLog(log);

const BUTTON_PICK_MS = 10 * 60_000;

const DISABLED: CliResult = {
  stdout: "",
  stderr: "nexus: the nexus command is turned off in NexusCode's settings (Agents)\n",
  exitCode: 1,
};

export interface SetupCliFeatureOptions {
  agentHost: ActivitySource & {
    call(method: string, args: unknown): Promise<unknown>;
    hasWorkspaceSessions?(workspaceId: string): boolean;
  };
  workspaceManager: {
    list(): WorkspaceMeta[];
    create(opts: {
      location: WorkspaceLocation;
      name?: string;
      color?: WorkspaceColor;
    }): WorkspaceMeta;
    update(
      id: string,
      partial: { pinned?: boolean; name?: string; color?: WorkspaceColor },
    ): WorkspaceMeta;
    reorder(
      id: string,
      opts: { beforeId?: string; afterId?: string; targetGroup: "pinned" | "unpinned" },
    ): WorkspaceMeta;
    getName(id: string): string | null;
    tryGetAgentChannel(id: string): Promise<AgentChannel | null>;
    connect(id: string): Promise<void>;
  };
  claudeBroker: ClaudeStatusBroker;
  claudeActivity?: {
    get(workspaceId: string, tabId: string): { agents: readonly AgentRun[] } | null;
    printRunSource?(
      workspaceId: string,
      tabId: string,
      runId: string,
    ): { home?: string } | undefined;
  };
  claudeAsks?: {
    list(workspaceId: string, tabId: string): readonly PermissionAsk[];
    answer(
      workspaceId: string,
      tabId: string,
      askId: string,
      answer: PermissionAnswer,
    ): Promise<boolean>;
  };
  remote?: () => CliRemote | null;
  onConsentsChanged?: () => void;
  stopPrintRun?: (workspaceId: string, tabId: string, agentId: string) => Promise<boolean>;
  activeContext: ActiveContextStore;
  appVersion: string;
  profileConnections: CliServices["profileConnections"];
  notificationsEnabled: () => boolean;
  setPreallowedWorkspaces: (ids: string[]) => void;
  settings: () => {
    enabled: boolean;
    crossWorkspace: CrossWorkspacePolicy;
    preallowedWorkspaces: readonly string[];
    agentContext: boolean;
  };
  getWindow: () => Pick<BrowserWindow, "webContents"> | null;
  isAppFocused: () => boolean;
  focusWindow: () => void;
  broadcast: (channel: string, event: string, args: unknown) => void;
  ports: { refresh(workspaceId: string): Promise<readonly ListeningPort[]> };
  forwards: CliForwards;
  claudeInstructions?: CliServices["claudeInstructions"];
  terminalClaudeInstructions?: CliServices["terminalClaudeInstructions"];
  notes: CliNotes;
}

export interface CliFeature {
  readonly services: CliServices;
  agentContextForChat(
    workspaceId: string,
    tabId: string,
    session?: string,
  ): Promise<ChatAgentContext | undefined>;
  noteInput(workspaceId: string, tabId: string): void;
  noteResize(workspaceId: string, tabId: string): void;
  dispose(): void;
}

export function setupCliFeature(options: SetupCliFeatureOptions): CliFeature {
  const { agentHost, workspaceManager } = options;
  const bridge = new RendererBridge(options.getWindow);
  const foregroundGroup = async (workspaceId: string, tabId: string, alone = false) => {
    const result = (await agentHost.call("foregroundProcess", {
      workspaceId,
      tabId,
      ...(alone ? { alone } : {}),
    })) as { name?: string; alone?: boolean } | undefined;
    const name = result?.name?.trim() ?? "";
    return name === "" ? null : { name, alone: result?.alone };
  };
  const foregroundProcess = async (workspaceId: string, tabId: string) =>
    (await foregroundGroup(workspaceId, tabId))?.name ?? null;
  const activity = new ActivityTracker(agentHost, Date.now, foregroundProcess);
  const claudeExit = new ClaudeExitWatch(agentHost, options.claudeBroker, (workspaceId, tabId) =>
    foregroundGroup(workspaceId, tabId, true),
  );
  const waits = new WaitRegistry(agentHost);
  const startedAgents = new StartedAgents(agentHost);
  const consents = new ConsentPrompts({
    ask: (args, timeoutMs, signal) => bridge.ask("consent.ask", args, timeoutMs, signal),
    settle: async (id, answer, by) =>
      (await bridge.ask("consent.settle", { id, answer, by })).settled,
    onChange: () => options.onConsentsChanged?.(),
  });
  const askConsent = async (request: ChangeRequest, signal?: AbortSignal) => {
    const args = consentArgsForChange(request);
    const pending = consents.ask(args, undefined, signal);
    if (args.crossWorkspace && !signal?.aborted) {
      const t = tryGetMainT();
      notifyTab(
        {
          isViewing: options.isAppFocused,
          notificationsEnabled: options.notificationsEnabled,
          workspaceName: (id) => workspaceManager.getName(id),
          reveal: options.focusWindow,
        },
        args.toWorkspaceId,
        args.fromTabId,
        t?.("settings:agentCli.consent.notificationTitle") ?? "Workspace approval requested",
        t?.("settings:agentCli.consent.notificationBody") ?? "Open NexusCode to answer",
      );
    }
    return (await pending).answer;
  };
  const consent = new CrossWorkspaceConsent({
    policy: () => options.settings().crossWorkspace,
    preallowed: () => options.settings().preallowedWorkspaces,
    workspaces: () => workspaceManager.list(),
    ask: askConsent,
    chatSession: (workspaceId, tabId, signal) =>
      bridge.ask("tab.sandboxSession", { workspaceId, tabId, chatOnly: true }, undefined, signal),
    sandboxSession: (workspaceId, tabId, signal) =>
      bridge.ask("tab.sandboxSession", { workspaceId, tabId }, undefined, signal),
  });
  const browser = new CdpBrowserDriver((tabId) => {
    const entry = getBrowserRegistry()?.get(tabId);
    return (
      entry && {
        contents: entry.view.webContents,
        view: entry.view,
        active: entry.active,
        loadFailure: entry.loadFailure,
      }
    );
  });
  const stopWatchingBrowsers = onBrowserTabCreated((tabId, contents) =>
    browser.watch(tabId, contents),
  );

  const sessionsRevision = new SessionsRevisions(bridge, () => options.getWindow()?.webContents);

  register("cli", {
    call: {
      uiRespond: async (args: unknown, ctx) => {
        bridge.resolve(validateArgs(ipcContract.cli.call.uiRespond.args, args), ctx?.sender?.id);
        return ipcOk(undefined);
      },
      workspaceGrants: async (_args, ctx) => {
        const sessions = await consent.grants(ctx?.signal);
        return ipcOk({ preallowed: [...options.settings().preallowedWorkspaces], sessions });
      },
      setWorkspaceGrant: async (args: unknown) => {
        const { workspaceId, allowed } = validateArgs(
          ipcContract.cli.call.setWorkspaceGrant.args,
          args,
        );
        if (allowed && grantWorkspaceId(workspaceManager.list(), workspaceId) !== workspaceId) {
          return ipcErr("not-found", "That workspace is no longer available", {
            category: "failed",
          });
        }
        const ids = new Set(options.settings().preallowedWorkspaces);
        if (allowed) ids.add(workspaceId);
        else ids.delete(workspaceId);
        options.setPreallowedWorkspaces([...ids]);
        return ipcOk(undefined);
      },
      revokeSessionGrant: async (args: unknown) => {
        const { id } = validateArgs(ipcContract.cli.call.revokeSessionGrant.args, args);
        consent.revoke(id);
        return ipcOk(undefined);
      },
      sessionsChanged: async (args: unknown, ctx) => {
        const { revision } = validateArgs(ipcContract.cli.call.sessionsChanged.args, args);
        if (ctx?.sender) sessionsRevision.saw(ctx.sender, revision);
        return ipcOk(undefined);
      },
      activity: async () => ipcOk(activity.snapshot()),
      waits: async () => ipcOk(waits.snapshot()),
      pickElement: async (args: unknown) => {
        const { tabId } = validateArgs(ipcContract.cli.call.pickElement.args, args);
        try {
          const result = await browser.pick(tabId, { timeoutMs: BUTTON_PICK_MS });
          if ("cancelled" in result) return ipcOk({ cancelled: result.cancelled });
          options.getWindow()?.webContents.focus();
          const screenshot = await pickPicture(tabId, result.picked);
          return ipcOk({ text: formatPick(result.picked, screenshot, shortId(tabId)) });
        } catch (error) {
          if (error instanceof CliError)
            return ipcErr("pick-failed", error.message, { category: "failed" });
          throw error;
        }
      },
      cancelPick: async (args: unknown) => {
        browser.cancelPick(validateArgs(ipcContract.cli.call.cancelPick.args, args).tabId);
        return ipcOk(undefined);
      },
    },
    listen: { uiRequest: {} },
  });

  const pickPicture = async (tabId: string, picked: PickedElement): Promise<string | undefined> => {
    const workspaceId = getBrowserRegistry()?.get(tabId)?.workspaceId;
    const workspace = workspaceManager.list().find((w) => w.id === workspaceId);
    if (picked.png === undefined || workspace?.location.kind !== "local") return undefined;
    try {
      return await savePickPicture(tmpdir(), shortId(tabId), picked.png, Date.now());
    } catch (error) {
      log.warn(
        `saving a picked element's picture failed: ${redactLogSecrets(error instanceof Error ? error.message : String(error))}`,
      );
      return undefined;
    }
  };

  const reveal = (workspaceId: string, tabId: string) => {
    options.focusWindow();
    workspaceManager.connect(workspaceId).catch((error: unknown) => {
      log.warn(
        `connecting ${shortId(workspaceId)} failed: ${safeText(error instanceof Error ? error.message : String(error), 200, redactLogSecrets)}`,
      );
    });
    options.broadcast("pty", "notificationClick", { workspaceId, tabId });
  };

  const services: CliServices = {
    appVersion: options.appVersion,
    sessionsRevision,
    profileConnections: options.profileConnections,
    listWorkspaces: () => workspaceManager.list(),
    addWorkspace: async (location, name, color) => {
      const listed = await listedAt(workspaceManager.list(), location);
      if (listed) return { workspace: listed, added: false };
      if (location.kind === "local") {
        const found = await stat(location.rootPath).catch(() => null);
        if (!found?.isDirectory()) throw new CliError(`no folder at ${location.rootPath}`);
      }
      return {
        workspace: workspaceManager.create({
          location,
          ...(name ? { name } : {}),
          ...(color ? { color } : {}),
        }),
        added: true,
      };
    },
    editWorkspace: (id, edit) => workspaceManager.update(id, edit),
    pinWorkspace: (id, pinned) => workspaceManager.update(id, { pinned }),
    moveWorkspace: (id, { group, ...anchor }) =>
      workspaceManager.reorder(id, { ...anchor, targetGroup: group }),
    shownTab: () => options.activeContext.get(),
    hasRunningTerminals: options.agentHost.hasWorkspaceSessions?.bind(options.agentHost),
    claudeStatus: (workspaceId, tabId) => options.claudeBroker.get(workspaceId, tabId),
    activity: (workspaceId, tabId) => activity.get(workspaceId, tabId),
    claudeAsks: (workspaceId, tabId) => options.claudeAsks?.list(workspaceId, tabId) ?? [],
    answerClaudeAsk: async (workspaceId, tabId, askId, answer) =>
      (await options.claudeAsks?.answer(workspaceId, tabId, askId, answer)) ?? false,
    claudeAgents: {
      list: (workspaceId, tabId) => options.claudeActivity?.get(workspaceId, tabId)?.agents ?? [],
      stop: async (workspaceId, tabId, agentId) =>
        (await options.stopPrintRun?.(workspaceId, tabId, agentId)) ?? false,
      keepsSession: (workspaceId, tabId, runId) =>
        options.claudeActivity?.printRunSource?.(workspaceId, tabId, runId)?.home !== undefined,
    },
    waits: {
      begin: (waiter, target, since) => waits.begin(waiter, target, since),
    },
    remote: {
      inRoom: () => options.remote?.()?.inRoom() ?? false,
      devices: async (signal) => (await options.remote?.()?.devices(signal)) ?? null,
      alias: async (deviceId, alias) => {
        const remote = options.remote?.();
        if (!remote?.alias) throw new CliError("device aliases are unavailable");
        await remote.alias(deviceId, alias);
      },
      request: (deviceId, method, params, timeoutMs, signal) => {
        const remote = options.remote?.();
        if (!remote) {
          throw new CliError("this computer is not in the remote room (Settings › Remote)", 3);
        }
        return remote.request(deviceId, method, params, timeoutMs, signal);
      },
    },
    consents,
    ui: <K extends CliUiOp>(op: K, args: CliUiOps[K]["args"], timeoutMs?: number) =>
      op === "consent.ask"
        ? (consents.ask(args as CliUiOps["consent.ask"]["args"], timeoutMs) as Promise<
            CliUiOps[K]["result"]
          >)
        : bridge.ask(op, args, timeoutMs),
    notify: (workspaceId, tabId, title, body) =>
      notifyTab(
        {
          isViewing: (ws, tab) => options.isAppFocused() && options.activeContext.isActive(ws, tab),
          notificationsEnabled: options.notificationsEnabled,
          workspaceName: (id) => workspaceManager.getName(id),
          reveal,
        },
        workspaceId,
        tabId,
        title,
        body,
      ),
    stat: async (workspaceId, relPath) => {
      const channel = await workspaceManager.tryGetAgentChannel(workspaceId);
      if (!channel) throw new Error("that workspace is not connected");
      try {
        return FsStatSchema.parse(await channel.call("fs.stat", { relPath })).type;
      } catch (error) {
        if ((error as { code?: unknown }).code === "NOT_FOUND") return null;
        throw error;
      }
    },
    readFile: async (workspaceId, absolutePath) => {
      const channel = await workspaceManager.tryGetAgentChannel(workspaceId);
      if (!channel) throw new Error("that workspace is not connected");
      const read = FileReadBinaryResultSchema.parse(
        await channel.call(FS_READ_ABSOLUTE_BINARY_METHOD, { absolutePath }),
      );
      return read.kind === "ok" ? read.base64 : null;
    },
    allowChange: (request, signal) => consent.check(request, signal),
    askUser: (request, signal) => consent.ask(request, signal),
    agentContextEnabled: () => options.settings().enabled && options.settings().agentContext,
    claudeInstructions: options.claudeInstructions,
    terminalClaudeInstructions: options.terminalClaudeInstructions,
    foregroundProcess,
    listeningPorts: (workspaceId) => options.ports.refresh(workspaceId),
    forwards: options.forwards,
    startedAgents,
    clock: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    browser,
    notes: options.notes,
  };

  const run = (caller: CliCaller, request: CliInvocation, signal: AbortSignal) => {
    if (!options.settings().enabled && request.argv[0] !== "agent-context") {
      return Promise.resolve(DISABLED);
    }
    return runCli(CLI_COMMANDS, { caller, invocation: request, services, signal });
  };

  const running = new Map<string, AbortController>();

  const respond = async (workspaceId: string, requestId: string, response: CliResult) => {
    const channel = await workspaceManager.tryGetAgentChannel(workspaceId);
    if (!channel) {
      log.warn(`cli.respond: no agent for workspace ${shortId(workspaceId)}`);
      return;
    }
    await channel.call("cli.respond", { requestId, response });
  };

  const off = agentHost.on("cli.request", (payload) => {
    const parsed = CliRequestSchema.safeParse(payload);
    if (!parsed.success) {
      log.warn("Rejected a malformed cli.request");
      const ref = CliRequestRefSchema.safeParse(payload);
      if (ref.success) {
        const { workspaceId, requestId } = ref.data;
        void respond(workspaceId, requestId, {
          stdout: "",
          stderr: "nexus: invalid CLI request\n",
          exitCode: 1,
        }).catch(() => log.warn("Could not reply to a malformed cli.request"));
      }
      return;
    }
    const { requestId, workspaceId, tabId, request, verified } = parsed.data;
    const controller = new AbortController();
    running.set(requestId, controller);
    const name = commandName(CLI_COMMANDS, request.argv);
    const waits = commandWaits(CLI_COMMANDS, request.argv);
    const startedAt = Date.now();
    run(
      { workspaceId, tabId, ...(verified !== undefined ? { verified } : {}) },
      request,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) return respond(workspaceId, requestId, result);
      })
      .catch((error: unknown) => {
        log.warn(
          `cli request ${requestId} failed: command=${name} ms=${Date.now() - startedAt} ${safeText(error instanceof Error ? error.message : String(error), 200, redactLogSecrets)}`,
        );
      })
      .finally(() => {
        running.delete(requestId);
        noteSlowRequest(slowRequests, name, waits, Date.now() - startedAt);
      });
  });
  const offCancel = agentHost.on("cli.cancel", (payload) => {
    const parsed = CliCancelSchema.safeParse(payload);
    if (parsed.success) running.get(parsed.data.requestId)?.abort();
  });

  return {
    services,
    agentContextForChat: async (workspaceId, tabId, session) => {
      const context = chatAgentContext(options.settings(), services, workspaceId, tabId);
      if (!context) return undefined;
      const linked = await linkedNoteGuidance(services.notes, {
        workspaceId,
        tabId,
        agent: "codex",
        session,
      });
      return linked ? { ...context, status: `${context.status}\n${linked}` } : context;
    },
    noteInput: (workspaceId, tabId) => activity.noteInput(workspaceId, tabId),
    noteResize: (workspaceId, tabId) => activity.noteResize(workspaceId, tabId),
    dispose: () => {
      off();
      offCancel();
      for (const controller of running.values()) controller.abort();
      stopWatchingBrowsers();
      activity.dispose();
      claudeExit.dispose();
      waits.dispose();
      startedAgents.dispose();
      sessionsRevision.dispose();
      bridge.dispose();
    },
  };
}
