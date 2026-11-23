import type { ClaudeTurnResult } from "../../../shared/claude/turn-result";
import { broadcast } from "../../infra/ipc-router";
import type { PtyHostHandle } from "../pty/types";
import { getActiveAppWindow, getFocusedAppWindow } from "../window/app-windows";
import { ActiveContextStore } from "./active-context";
import { ChatAnswers } from "./chat-answers";
import type { WorkspaceNameLookup } from "./hook-handler";
import { answerHook, PRINT_STOP_ANSWER, registerHookHandler } from "./hook-handler";
import { ClaudeInterruptWatcher } from "./interrupt";
import { registerClaudeChannel } from "./ipc";
import { answersDialog, PermissionAsks } from "./permission-asks";
import { MAIN_AGENT, PermissionDialogs } from "./permission-dialogs";
import { ClaudeReconnectCheck } from "./reconnect";
import { SessionActivityLog } from "./session-activity";
import { ClaudeStatusBroker } from "./status";
import { TurnOrder } from "./turn-order";

export interface SetupClaudeFeatureOptions {
  agentHost: PtyHostHandle;
  workspaceManager: WorkspaceNameLookup & {
    tryGetAgentChannel(
      id: string,
    ): Promise<import("../../infra/agent/channel").AgentChannel | null>;
    connect(id: string): Promise<void>;
  };
  getFocusedWindow?: () => import("electron").BrowserWindow | null;
  electronNotificationCtor?: typeof import("electron").Notification;
  broadcastFn?: (channel: string, event: string, args: unknown) => void;
  notificationsEnabled?: () => boolean;
}

export interface SetupClaudeFeatureResult {
  isActiveTab: (workspaceId: string, tabId: string) => boolean;
  noteInput: (workspaceId: string, tabId: string, data: string) => void;
  noteTurnResult: (workspaceId: string, tabId: string, result: ClaudeTurnResult) => void;
  noteProgramExit: (workspaceId: string, tabId: string) => void;
  dispose: () => void;
  broker: ClaudeStatusBroker;
  activeContext: ActiveContextStore;
  activity: SessionActivityLog;
  asks: PermissionAsks;
  stopPrintRun: (workspaceId: string, tabId: string, agentId: string) => Promise<boolean>;
}

export function setupClaudeFeature(options: SetupClaudeFeatureOptions): SetupClaudeFeatureResult {
  const { agentHost, workspaceManager } = options;

  const broadcastFn = options.broadcastFn ?? broadcast;

  const broker = new ClaudeStatusBroker(broadcastFn);
  const activeContext = new ActiveContextStore();
  const activity = new SessionActivityLog();
  const asks = new PermissionAsks((workspaceId, hookId, response) =>
    answerHook(workspaceManager, workspaceId, hookId, response),
  );
  const chatAnswers = new ChatAnswers();

  const stopPrintRun = async (workspaceId: string, tabId: string, agentId: string) => {
    const watch = activity.printWatch(workspaceId, tabId, agentId);
    if (watch === undefined) return false;
    const result = await answerHook(workspaceManager, workspaceId, watch, {
      stdout: PRINT_STOP_ANSWER,
      exitCode: 0,
    });
    return result === "answered";
  };

  registerClaudeChannel(broker, activeContext, activity, asks, chatAnswers, stopPrintRun);

  const getFocusedWindow = options.getFocusedWindow ?? getFocusedAppWindow;
  const turns = new TurnOrder();
  const dialogs = new PermissionDialogs();

  const offHook = registerHookHandler(
    {
      broker,
      activeContext,
      activity,
      asks,
      chatAnswers,
      agentHost,
      channelProvider: workspaceManager,
      workspaceManager,
      getFocusedWindow,
      electronNotificationCtor: options.electronNotificationCtor,
      broadcastFn,
      notificationsEnabled: options.notificationsEnabled,
      connectWorkspace: (id) => workspaceManager.connect(id),
      focusMainWindow: () => {
        const win = getActiveAppWindow();
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      },
    },
    turns,
    dialogs,
  );

  const offCleared = broker.onChange((workspaceId, tabId, entry) => {
    if (entry === null) {
      activity.clear(workspaceId, tabId);
      asks.clear(workspaceId, tabId);
    } else if (entry.status === "idle") {
      activity.noteTurnOver(workspaceId, tabId);
    }
  });

  const interrupts = new ClaudeInterruptWatcher(broker);

  const reconnects = new ClaudeReconnectCheck(broker, async (workspaceId, tabId) => {
    const result = (await agentHost.call("foregroundProcess", { workspaceId, tabId })) as
      | { name?: string }
      | undefined;
    const name = result?.name?.trim() ?? "";
    return name === "" ? null : name;
  });

  const noteProgramExit = (workspaceId: string, tabId: string): void => {
    turns.end(workspaceId, tabId);
    dialogs.clear(`${workspaceId}:${tabId}`);
    broker.clear(workspaceId, tabId);
    activity.clear(workspaceId, tabId);
    asks.clear(workspaceId, tabId);
  };

  const offExit = agentHost.on("exit", (args) => {
    const a = args as Record<string, unknown>;
    const workspaceId = typeof a?.workspaceId === "string" ? a.workspaceId : null;
    const tabId = typeof a?.tabId === "string" ? a.tabId : null;
    if (workspaceId && tabId) {
      noteProgramExit(workspaceId, tabId);
      interrupts.forget(workspaceId, tabId);
      reconnects.forget(workspaceId, tabId);
    }
  });

  const offData = agentHost.on("data", (args) => {
    const { workspaceId, tabId, chunk, replay } = args as {
      workspaceId: string;
      tabId: string;
      chunk: string;
      replay?: boolean;
    };
    if (replay) reconnects.noteReplay(workspaceId, tabId, chunk);
    else interrupts.noteOutput(workspaceId, tabId, chunk);
  });

  const offRestored = agentHost.on("restored", (args) => {
    const { workspaceId, tabId, withReplay } = args as {
      workspaceId: string;
      tabId: string;
      withReplay: boolean;
    };
    reconnects.noteRestored(workspaceId, tabId, withReplay);
  });

  const offReplayed = agentHost.on("replayed", (args) => {
    const { workspaceId, tabId } = args as { workspaceId: string; tabId: string };
    void reconnects.noteReplayed(workspaceId, tabId);
  });

  return {
    isActiveTab: (workspaceId, tabId) => activeContext.isActive(workspaceId, tabId),
    noteInput: (workspaceId, tabId, data) => {
      interrupts.noteInput(workspaceId, tabId, data);
      if (answersDialog(data)) asks.answeredInTerminal(workspaceId, tabId);
    },
    noteTurnResult: (workspaceId, tabId, result) => {
      if (!turns.acceptsResult(workspaceId, tabId, result.promptId)) return;
      const key = `${workspaceId}:${tabId}`;
      dialogs.closeAgent(key, MAIN_AGENT);
      asks.retain(workspaceId, tabId, (agent) => agent !== MAIN_AGENT);
      const focused = getFocusedWindow();
      const viewing =
        focused !== null && !focused.isMinimized() && activeContext.isActive(workspaceId, tabId);
      const status =
        result.outcome === "error"
          ? "error"
          : result.outcome === "interrupted" || viewing
            ? "idle"
            : "completed";
      const message = result.outcome === "interrupted" ? undefined : result.detail?.slice(0, 500);
      if (dialogs.isOpen(key)) {
        dialogs.setUnder(key, { status, message });
      } else {
        const previous = broker.get(workspaceId, tabId);
        broker.set(
          workspaceId,
          tabId,
          status,
          message ?? (status === previous?.status ? previous.message : undefined),
        );
      }
    },
    noteProgramExit,
    dispose: () => {
      offHook();
      offCleared();
      offExit();
      offData();
      offRestored();
      offReplayed();
      reconnects.dispose();
    },
    broker,
    activeContext,
    activity,
    asks,
    stopPrintRun,
  };
}

export { ClaudeStatusBroker } from "./status";
