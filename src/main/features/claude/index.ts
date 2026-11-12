// Claude feature entry point — broker / IPC / hook-handler wiring.
//
// setupClaudeFeature() is called after app.whenReady() in src/main/index.ts.

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
import { ClaudeReconnectCheck } from "./reconnect";
import { SessionActivityLog } from "./session-activity";
import { ClaudeStatusBroker } from "./status";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface SetupClaudeFeatureOptions {
  /** Used to subscribe to PTY events (exit / claude.hook). */
  agentHost: PtyHostHandle;
  /** For workspace name lookup + tryGetAgentChannel. */
  workspaceManager: WorkspaceNameLookup & {
    tryGetAgentChannel(
      id: string,
    ): Promise<import("../../infra/agent/channel").AgentChannel | null>;
    activate(id: string): Promise<void>;
  };
  /** BrowserWindow.getFocusedWindow — for test injection. */
  getFocusedWindow?: () => import("electron").BrowserWindow | null;
  /** OS notification constructor — for test injection. */
  electronNotificationCtor?: typeof import("electron").Notification;
  /** broadcast function injection — for tests. */
  broadcastFn?: (channel: string, event: string, args: unknown) => void;
  /**
   * OS notification master toggle getter — returns false when turned off in Settings.
   * Forwarded to hook-handler. Evaluated just before each fire, so it takes effect at once.
   */
  notificationsEnabled?: () => boolean;
}

// ---------------------------------------------------------------------------
// Main setup function
// ---------------------------------------------------------------------------

export interface SetupClaudeFeatureResult {
  /** Whether this is the active tab the renderer last reported — other programs' notifications use the same criterion. */
  isActiveTab: (workspaceId: string, tabId: string) => boolean;
  /** Input typed into a terminal, which can interrupt Claude's turn or answer its dialog. */
  noteInput: (workspaceId: string, tabId: string, data: string) => void;
  /**
   * A Claude tab's turn ended short: interrupted, or failed. No hook says so,
   * and the tab's program tells it in a result line.
   */
  noteTurnStopped: (workspaceId: string, tabId: string) => void;
  /** A Claude tab's program exited, maybe without its SessionEnd hook. */
  noteProgramExit: (workspaceId: string, tabId: string) => void;
  /** Function that releases every subscription. */
  dispose: () => void;
  /** Each tab's Claude state, which the nexus CLI reports too. */
  broker: ClaudeStatusBroker;
  /** The tab the user is looking at. */
  activeContext: ActiveContextStore;
  /** What each session is doing: its tools, todos and agents. */
  activity: SessionActivityLog;
  /**
   * Stops the session's running `claude -p` run `agentId`, as the session's
   * ^C would: false when it is no such run, or could not be told.
   */
  stopPrintRun: (workspaceId: string, tabId: string, agentId: string) => Promise<boolean>;
}

/**
 * Initializes the Claude feature and connects all wiring.
 *
 * 1. Create the ClaudeStatusBroker.
 * 2. Register the IPC channels.
 * 3. Register hook-handler + subscribe to agentHost.on("claude.hook").
 * 4. Subscribe to broker.clear on PTY exit.
 *
 * The hookserver connection info is looked up by pull from WorkspaceManager.getHookInfo().
 *
 * @returns { dispose }
 */
export function setupClaudeFeature(options: SetupClaudeFeatureOptions): SetupClaudeFeatureResult {
  const { agentHost, workspaceManager } = options;

  const broadcastFn = options.broadcastFn ?? broadcast;

  // 1. Create the status broker + active context store.
  const broker = new ClaudeStatusBroker(broadcastFn);
  const activeContext = new ActiveContextStore();
  const activity = new SessionActivityLog();
  const asks = new PermissionAsks((workspaceId, hookId, response) =>
    answerHook(workspaceManager, workspaceId, hookId, response),
  );
  const chatAnswers = new ChatAnswers();

  // A `claude -p` run stops when the app answers its watch.
  const stopPrintRun = async (workspaceId: string, tabId: string, agentId: string) => {
    const watch = activity.printWatch(workspaceId, tabId, agentId);
    if (watch === undefined) return false;
    return answerHook(workspaceManager, workspaceId, watch, {
      stdout: PRINT_STOP_ANSWER,
      exitCode: 0,
    });
  };

  // 2. Register the IPC channels (must be called after setupRouter()).
  registerClaudeChannel(broker, activeContext, activity, asks, chatAnswers, stopPrintRun);

  // 3. Register hook-handler.
  const getFocusedWindow = options.getFocusedWindow ?? getFocusedAppWindow;

  const offHook = registerHookHandler({
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
    activateWorkspace: (id) => workspaceManager.activate(id),
    focusMainWindow: () => {
      const win = getActiveAppWindow();
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  });

  // Claude gone without its SessionEnd hook (its exit seen, its state cleared
  // by hand) takes its record along: the agents it ran stopped with it.
  const offCleared = broker.onChange((workspaceId, tabId, entry) => {
    if (entry === null) {
      activity.clear(workspaceId, tabId);
      asks.clear(workspaceId, tabId);
    } else if (entry.status === "idle") {
      // A turn interrupted ends with no hook: its tools stopped with it.
      activity.noteTurnOver(workspaceId, tabId);
    }
  });

  // An interrupted turn runs no hook; its "Interrupted" line ends it.
  const interrupts = new ClaudeInterruptWatcher(broker);

  // Hooks run while a held terminal's link was down are lost; once it comes
  // back, its replayed output tells its state again.
  const reconnects = new ClaudeReconnectCheck(broker, async (workspaceId, tabId) => {
    const result = (await agentHost.call("foregroundProcess", { workspaceId, tabId })) as
      | { name?: string }
      | undefined;
    const name = result?.name?.trim() ?? "";
    return name === "" ? null : name;
  });

  // 4. broker.clear on PTY exit — remove the status entry when a tab closes (prevents a memory leak).
  const offExit = agentHost.on("exit", (args) => {
    const a = args as Record<string, unknown>;
    const workspaceId = typeof a?.workspaceId === "string" ? a.workspaceId : null;
    const tabId = typeof a?.tabId === "string" ? a.tabId : null;
    if (workspaceId && tabId) {
      broker.clear(workspaceId, tabId);
      activity.clear(workspaceId, tabId);
      asks.clear(workspaceId, tabId);
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
      // The dialog answered in the terminal no longer waits on the app.
      if (answersDialog(data)) asks.answeredInTerminal(workspaceId, tabId);
    },
    noteTurnStopped: (workspaceId, tabId) => {
      const status = broker.get(workspaceId, tabId)?.status;
      if (status === "running" || status === "permissionPending") {
        broker.set(workspaceId, tabId, "idle");
      }
    },
    noteProgramExit: (workspaceId, tabId) => {
      broker.clear(workspaceId, tabId);
      activity.clear(workspaceId, tabId);
      asks.clear(workspaceId, tabId);
    },
    dispose: () => {
      offHook();
      offCleared();
      offExit();
      offData();
      offRestored();
      offReplayed();
    },
    broker,
    activeContext,
    activity,
    stopPrintRun,
  };
}

export { ClaudeStatusBroker } from "./status";
