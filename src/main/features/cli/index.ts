/**
 * The nexus CLI in main: takes the "cli.request" events the workspaces'
 * agents relay from their terminals, runs the command, and answers through
 * the same agent.
 */
import { CliRequestSchema, type CliResult } from "../../../shared/cli/protocol";
import type { CliUiOp, CliUiOps } from "../../../shared/cli/ui";
import { FsStatSchema } from "../../../shared/fs/types";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import { createLogger } from "../../../shared/log/main";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { AgentChannel } from "../../infra/agent/channel";
import { register, validateArgs } from "../../infra/ipc-router";
import type { ActiveContextStore } from "../claude/active-context";
import type { ClaudeStatusBroker } from "../claude/status";
import { type ActivitySource, ActivityTracker } from "./activity";
import { CLI_COMMANDS } from "./commands";
import type { CliServices } from "./context";
import { notifyTab } from "./notifier";
import { runCli } from "./registry";
import { RendererBridge, type UiWindow } from "./renderer-bridge";

const log = createLogger("cli");

export interface SetupCliFeatureOptions {
  /** Relays the agents' "cli.request" events and the terminals' output. */
  agentHost: ActivitySource;
  workspaceManager: {
    list(): WorkspaceMeta[];
    getName(id: string): string | null;
    tryGetAgentChannel(id: string): Promise<AgentChannel | null>;
    activate(id: string): Promise<void>;
  };
  claudeBroker: ClaudeStatusBroker;
  activeContext: ActiveContextStore;
  appVersion: string;
  notificationsEnabled: () => boolean;
  /** The app window the renderer side of the CLI runs in. */
  getWindow: () => UiWindow | null;
  /** Whether the app has focus. */
  isAppFocused: () => boolean;
  /** Brings the app's window forward. */
  focusWindow: () => void;
  /** Sends an event to the renderer. */
  broadcast: (channel: string, event: string, args: unknown) => void;
}

export interface CliFeature {
  dispose(): void;
}

export function setupCliFeature(options: SetupCliFeatureOptions): CliFeature {
  const { agentHost, workspaceManager } = options;
  const bridge = new RendererBridge(options.getWindow);
  const activity = new ActivityTracker(agentHost);

  register("cli", {
    call: {
      uiRespond: async (args: unknown) => {
        bridge.resolve(validateArgs(ipcContract.cli.call.uiRespond.args, args));
        return ipcOk(undefined);
      },
    },
    listen: { uiRequest: {} },
  });

  const reveal = (workspaceId: string, tabId: string) => {
    options.focusWindow();
    workspaceManager.activate(workspaceId).catch((error: unknown) => {
      log.warn(`activating ${workspaceId} failed: ${(error as Error).message}`);
    });
    options.broadcast("pty", "notificationClick", { workspaceId, tabId });
  };

  const services: CliServices = {
    appVersion: options.appVersion,
    listWorkspaces: () => workspaceManager.list(),
    shownTab: () => options.activeContext.get(),
    claudeStatus: (workspaceId, tabId) => options.claudeBroker.get(workspaceId, tabId),
    activity: (workspaceId, tabId) => activity.get(workspaceId, tabId),
    ui: <K extends CliUiOp>(op: K, args: CliUiOps[K]["args"]) => bridge.ask(op, args),
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
  };

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
    runCli(CLI_COMMANDS, { caller: { workspaceId, tabId }, invocation: request, services })
      .then((result) => respond(workspaceId, requestId, result))
      .catch((error: unknown) => {
        log.warn(`cli request ${requestId} failed: ${(error as Error).message}`);
      });
  });

  return {
    dispose: () => {
      off();
      activity.dispose();
      bridge.dispose();
    },
  };
}
