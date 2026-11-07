// Claude feature 진입점 — broker / IPC / hook-handler wiring.
//
// setupClaudeFeature()를 src/main/index.ts의 app.whenReady() 이후에 호출한다.

import { broadcast } from "../../infra/ipc-router";
import { ClaudeStatusBroker } from "./status";
import { ActiveContextStore } from "./active-context";
import { ChatAnswers } from "./chat-answers";
import { registerClaudeChannel } from "./ipc";
import { answerHook, PRINT_STOP_ANSWER, registerHookHandler } from "./hook-handler";
import { answersDialog, PermissionAsks } from "./permission-asks";
import { SessionActivityLog } from "./session-activity";
import { ClaudeInterruptWatcher } from "./interrupt";
import { ClaudeReconnectCheck } from "./reconnect";
import type { PtyHostHandle } from "../pty/types";
import type { WorkspaceNameLookup } from "./hook-handler";
import { getActiveAppWindow, getFocusedAppWindow } from "../window/app-windows";

// ---------------------------------------------------------------------------
// 의존성 타입
// ---------------------------------------------------------------------------

export interface SetupClaudeFeatureOptions {
  /** PTY 이벤트(exit / claude.hook) 구독에 사용한다. */
  agentHost: PtyHostHandle;
  /** 워크스페이스 이름 조회 + tryGetAgentChannel 용도. */
  workspaceManager: WorkspaceNameLookup & {
    tryGetAgentChannel(
      id: string,
    ): Promise<import("../../infra/agent/channel").AgentChannel | null>;
    activate(id: string): Promise<void>;
  };
  /** BrowserWindow.getFocusedWindow — 테스트 주입용. */
  getFocusedWindow?: () => import("electron").BrowserWindow | null;
  /** OS 알림 생성자 — 테스트 주입용. */
  electronNotificationCtor?: typeof import("electron").Notification;
  /** broadcast 함수 주입 — 테스트용. */
  broadcastFn?: (channel: string, event: string, args: unknown) => void;
  /**
   * OS 알림 마스터 토글 getter — Settings에서 끈 경우 false 반환.
   * hook-handler에 forward한다. 매 발사 직전 평가되므로 즉시 반영.
   */
  notificationsEnabled?: () => boolean;
}

// ---------------------------------------------------------------------------
// 주 setup 함수
// ---------------------------------------------------------------------------

export interface SetupClaudeFeatureResult {
  /** renderer가 마지막으로 알린 활성 탭인지 — 다른 프로그램의 알림도 같은 기준을 쓴다. */
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
  /** 모든 구독을 해제하는 함수. */
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
 * Claude feature를 초기화하고 모든 wiring을 연결한다.
 *
 * 1. ClaudeStatusBroker 생성.
 * 2. IPC 채널 등록.
 * 3. hook-handler 등록 + agentHost.on("claude.hook") 구독.
 * 4. PTY exit 시 broker.clear 구독.
 *
 * hookserver 접속 정보는 pull 기반으로 WorkspaceManager.getHookInfo()에서 조회한다.
 *
 * @returns { dispose }
 */
export function setupClaudeFeature(options: SetupClaudeFeatureOptions): SetupClaudeFeatureResult {
  const { agentHost, workspaceManager } = options;

  const broadcastFn = options.broadcastFn ?? broadcast;

  // 1. Status broker + active context store 생성.
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

  // 2. IPC 채널 등록 (setupRouter() 이후에 호출되어야 함).
  registerClaudeChannel(broker, activeContext, activity, asks, chatAnswers, stopPrintRun);

  // 3. hook-handler 등록.
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

  // 4. PTY exit 시 broker.clear — 탭 종료 시 상태 항목 제거(메모리 누수 방지).
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
