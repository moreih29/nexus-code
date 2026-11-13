/**
 * The nexus CLI in main: takes the "cli.request" events the workspaces'
 * agents relay from their terminals, runs the command, and answers through
 * the same agent.
 */
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AgentRun } from "../../../shared/claude/activity";
import {
  CliCancelSchema,
  type CliInvocation,
  CliRequestSchema,
  type CliResult,
} from "../../../shared/cli/protocol";
import type { CliUiOp, CliUiOps } from "../../../shared/cli/ui";
import { FsStatSchema } from "../../../shared/fs/types";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import { createLogger } from "../../../shared/log/main";
import { isManagerWorkspace, type ManagerPermissions } from "../../../shared/manager/manager";
import type { ListeningPort } from "../../../shared/pty/ports";
import type { WorkspaceLocation, WorkspaceMeta } from "../../../shared/types/workspace";
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
  askEachTime,
  type ChangeRequest,
  CrossWorkspaceConsent,
  type CrossWorkspacePolicy,
} from "./consent";
import { CliError, type CliForwards, type CliServices, shortId } from "./context";
import { listedAt } from "./listed";
import { notifyTab } from "./notifier";
import { runCli } from "./registry";
import { RendererBridge, type UiWindow } from "./renderer-bridge";
import { StartedAgents } from "./started-agents";
import { WaitRegistry } from "./waits";

const log = createLogger("cli");

/** How long a pick started from a browser tab's button waits for the click. */
const BUTTON_PICK_MS = 10 * 60_000;

const DISABLED: CliResult = {
  stdout: "",
  stderr: "nexus: the nexus command is turned off in NexusCode's settings (Agents)\n",
  exitCode: 1,
};
const DISABLED_QUIETLY: CliResult = { stdout: "", stderr: "", exitCode: 0 };

export interface SetupCliFeatureOptions {
  /**
   * Relays the agents' "cli.request" and "cli.cancel" events and the terminals' output, and
   * asks a terminal's agent which program holds its foreground.
   */
  agentHost: ActivitySource & { call(method: string, args: unknown): Promise<unknown> };
  workspaceManager: {
    list(): WorkspaceMeta[];
    create(opts: { location: WorkspaceLocation; name?: string }): WorkspaceMeta;
    getName(id: string): string | null;
    tryGetAgentChannel(id: string): Promise<AgentChannel | null>;
    activate(id: string): Promise<void>;
  };
  claudeBroker: ClaudeStatusBroker;
  /** The agents of Claude sessions, for nexus agent. */
  claudeActivity?: {
    get(workspaceId: string, tabId: string): { agents: readonly AgentRun[] } | null;
  };
  /** Stops a session's running `claude -p` run; false when the app cannot tell it to. */
  stopPrintRun?: (workspaceId: string, tabId: string, agentId: string) => Promise<boolean>;
  activeContext: ActiveContextStore;
  appVersion: string;
  notificationsEnabled: () => boolean;
  /** The nexus settings (Settings › Agents), read on every command. */
  settings: () => {
    enabled: boolean;
    crossWorkspace: CrossWorkspacePolicy;
    agentContext: boolean;
    /** What the agent manager may do with another session's permission request. */
    managerPermissions: ManagerPermissions;
  };
  /** The app window the renderer side of the CLI runs in. */
  getWindow: () => UiWindow | null;
  /** Whether the app has focus. */
  isAppFocused: () => boolean;
  /** Brings the app's window forward. */
  focusWindow: () => void;
  /** Sends an event to the renderer. */
  broadcast: (channel: string, event: string, args: unknown) => void;
  /** Looks at the ports the programs in a workspace's terminals listen on. */
  ports: { refresh(workspaceId: string): Promise<readonly ListeningPort[]> };
  /** The SSH workspaces' ports forwarded to this machine. */
  forwards: CliForwards;
}

export interface CliFeature {
  /** What the commands work with: the remote serves its own requests with them too. */
  readonly services: CliServices;
  /** A key typed into a terminal (activity.ts). */
  noteInput(workspaceId: string, tabId: string): void;
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
  // The renderer takes the prompt down at timeoutMs; the bridge waits a little longer.
  const askConsent = async (request: ChangeRequest, timeoutMs: number) =>
    (await bridge.ask("consent.ask", { ...request, timeoutMs }, timeoutMs + 10_000)).answer;
  const consent = new CrossWorkspaceConsent({
    policy: () => options.settings().crossWorkspace,
    ask: askConsent,
  });
  const browser = new CdpBrowserDriver((tabId) => {
    const entry = getBrowserRegistry()?.get(tabId);
    return entry && { contents: entry.view.webContents, view: entry.view, active: entry.active };
  });
  const stopWatchingBrowsers = onBrowserTabCreated((tabId, contents) =>
    browser.watch(tabId, contents),
  );

  register("cli", {
    call: {
      uiRespond: async (args: unknown) => {
        bridge.resolve(validateArgs(ipcContract.cli.call.uiRespond.args, args));
        return ipcOk(undefined);
      },
      activity: async () => ipcOk(activity.snapshot()),
      waits: async () => ipcOk(waits.snapshot()),
      pickElement: async (args: unknown) => {
        const { tabId } = validateArgs(ipcContract.cli.call.pickElement.args, args);
        const result = await browser.pick(tabId, { timeoutMs: BUTTON_PICK_MS });
        if ("cancelled" in result) return ipcOk({ cancelled: result.cancelled });
        // The click left the keyboard in the page; the agent's terminal is next.
        options.getWindow()?.webContents.focus();
        const screenshot = await pickPicture(tabId, result.picked);
        return ipcOk({ text: formatPick(result.picked, screenshot, shortId(tabId)) });
      },
      cancelPick: async (args: unknown) => {
        browser.cancelPick(validateArgs(ipcContract.cli.call.cancelPick.args, args).tabId);
        return ipcOk(undefined);
      },
    },
    listen: { uiRequest: {} },
  });

  /**
   * Saves the picture of an element picked with a tab's button where the
   * agent can read it: this machine's temp directory, so only for a local
   * workspace. An agent on an SSH host or in WSL gets none.
   */
  const pickPicture = async (tabId: string, picked: PickedElement): Promise<string | undefined> => {
    const workspaceId = getBrowserRegistry()?.get(tabId)?.workspaceId;
    const workspace = workspaceManager.list().find((w) => w.id === workspaceId);
    if (picked.png === undefined || workspace?.location.kind !== "local") return undefined;
    try {
      return await savePickPicture(tmpdir(), shortId(tabId), picked.png, Date.now());
    } catch (error) {
      log.warn(`saving a picked element's picture failed: ${(error as Error).message}`);
      return undefined;
    }
  };

  const reveal = (workspaceId: string, tabId: string) => {
    options.focusWindow();
    // The manager is shown in its dock, not in a workspace.
    if (isManagerWorkspace(workspaceId)) {
      options.broadcast("manager", "reveal", {});
      return;
    }
    workspaceManager.activate(workspaceId).catch((error: unknown) => {
      log.warn(`activating ${workspaceId} failed: ${(error as Error).message}`);
    });
    options.broadcast("pty", "notificationClick", { workspaceId, tabId });
  };

  const services: CliServices = {
    appVersion: options.appVersion,
    listWorkspaces: () => workspaceManager.list(),
    addWorkspace: async (location, name) => {
      const listed = await listedAt(workspaceManager.list(), location);
      if (listed) return { workspace: listed, added: false };
      if (location.kind === "local") {
        const found = await stat(location.rootPath).catch(() => null);
        if (!found?.isDirectory()) throw new CliError(`no folder at ${location.rootPath}`);
      }
      return {
        workspace: workspaceManager.create({ location, ...(name ? { name } : {}) }),
        added: true,
      };
    },
    shownTab: () => options.activeContext.get(),
    claudeStatus: (workspaceId, tabId) => options.claudeBroker.get(workspaceId, tabId),
    activity: (workspaceId, tabId) => activity.get(workspaceId, tabId),
    claudeAgents: {
      list: (workspaceId, tabId) => options.claudeActivity?.get(workspaceId, tabId)?.agents ?? [],
      stop: async (workspaceId, tabId, agentId) =>
        (await options.stopPrintRun?.(workspaceId, tabId, agentId)) ?? false,
    },
    waits: {
      begin: (waiter, target, since) => waits.begin(waiter, target, since),
    },
    ui: <K extends CliUiOp>(op: K, args: CliUiOps[K]["args"], timeoutMs?: number) =>
      bridge.ask(op, args, timeoutMs),
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
    allowChange: (request) => consent.check(request),
    askUser: (request) => askEachTime(request, askConsent),
    managerPermissions: () => options.settings().managerPermissions,
    agentContextEnabled: () => options.settings().agentContext,
    foregroundProcess,
    listeningPorts: (workspaceId) => options.ports.refresh(workspaceId),
    forwards: options.forwards,
    startedAgents,
    clock: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    browser,
  };

  const run = (
    caller: { workspaceId: string; tabId: string },
    request: CliInvocation,
    signal: AbortSignal,
  ) => {
    if (!options.settings().enabled) {
      // The SessionStart hook asks for the agent note in every session; it gets none.
      if (request.argv[0] === "agent-context") return Promise.resolve(DISABLED_QUIETLY);
      return Promise.resolve(DISABLED);
    }
    return runCli(CLI_COMMANDS, { caller, invocation: request, services, signal });
  };

  /** The requests still running, to abort when their client goes. */
  const running = new Map<string, AbortController>();

  const respond = async (workspaceId: string, requestId: string, response: CliResult) => {
    const channel = await workspaceManager.tryGetAgentChannel(workspaceId);
    if (!channel) {
      log.warn(`cli.respond: no agent for workspace ${workspaceId}`);
      return;
    }
    await channel.call("cli.respond", { requestId, response });
  };

  const off = agentHost.on("cli.request", (payload) => {
    const parsed = CliRequestSchema.safeParse(payload);
    if (!parsed.success) {
      log.warn("Dropped a malformed cli.request");
      return;
    }
    const { requestId, workspaceId, tabId, request } = parsed.data;
    const controller = new AbortController();
    running.set(requestId, controller);
    run({ workspaceId, tabId }, request, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) return respond(workspaceId, requestId, result);
      })
      .catch((error: unknown) => {
        log.warn(`cli request ${requestId} failed: ${(error as Error).message}`);
      })
      .finally(() => running.delete(requestId));
  });
  const offCancel = agentHost.on("cli.cancel", (payload) => {
    const parsed = CliCancelSchema.safeParse(payload);
    if (parsed.success) running.get(parsed.data.requestId)?.abort();
  });

  return {
    services,
    noteInput: (workspaceId, tabId) => activity.noteInput(workspaceId, tabId),
    dispose: () => {
      off();
      offCancel();
      for (const controller of running.values()) controller.abort();
      stopWatchingBrowsers();
      activity.dispose();
      claudeExit.dispose();
      waits.dispose();
      startedAgents.dispose();
      bridge.dispose();
    },
  };
}
