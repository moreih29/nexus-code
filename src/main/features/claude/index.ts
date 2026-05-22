// Claude feature 진입점 — broker / IPC / hook-handler wiring.
//
// setupClaudeFeature()를 src/main/index.ts의 app.whenReady() 이후에 호출한다.

import { broadcast } from "../../infra/ipc-router";
import { ClaudeStatusBroker } from "./status";
import { ActiveContextStore } from "./active-context";
import { registerClaudeChannel } from "./ipc";
import { registerHookHandler } from "./hook-handler";
import type { PtyHostHandle } from "../pty/types";
import type { WorkspaceNameLookup } from "./hook-handler";

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
}

// ---------------------------------------------------------------------------
// 주 setup 함수
// ---------------------------------------------------------------------------

export interface SetupClaudeFeatureResult {
  /** 모든 구독을 해제하는 함수. */
  dispose: () => void;
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

  // 2. IPC 채널 등록 (setupRouter() 이후에 호출되어야 함).
  registerClaudeChannel(broker, activeContext);

  // 3. hook-handler 등록.
  const getFocusedWindow =
    options.getFocusedWindow ??
    (() => {
      const electron = require("electron") as typeof import("electron");
      return electron.BrowserWindow.getFocusedWindow();
    });

  const offHook = registerHookHandler({
    broker,
    activeContext,
    agentHost,
    channelProvider: workspaceManager,
    workspaceManager,
    getFocusedWindow,
    electronNotificationCtor: options.electronNotificationCtor,
    broadcastFn,
    activateWorkspace: (id) => workspaceManager.activate(id),
    focusMainWindow: () => {
      const electron = require("electron") as typeof import("electron");
      const win = electron.BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  });

  // 4. PTY exit 시 broker.clear — 탭 종료 시 상태 항목 제거(메모리 누수 방지).
  const offExit = agentHost.on("exit", (args) => {
    const a = args as Record<string, unknown>;
    const workspaceId = typeof a?.workspaceId === "string" ? a.workspaceId : null;
    const tabId = typeof a?.tabId === "string" ? a.tabId : null;
    if (workspaceId && tabId) {
      broker.clear(workspaceId, tabId);
    }
  });

  return {
    dispose: () => {
      offHook();
      offExit();
    },
  };
}

export { ClaudeStatusBroker } from "./status";
