// Claude Code hook 이벤트 핸들러.
//
// Go agent의 hookserver가 "claude.hook" 이벤트를 push하면 이 모듈이 수신해
// subcommand별 상태 전이 + OS 알림 발사 + agentHost respondHook 호출을 처리한다.
//
// subcommand 매핑:
//   session-start      → broker.set(running)
//   user-prompt-submit → broker.set(running)
//   pre-tool-use       → broker.set(running) + 즉시 respondHook {exitCode:0} (async hook)
//   notification       → broker.set(needsInput, message) + OS 알림 발사(비포커스 시)
//   permission-request → broker.set(permissionPending, message) + OS 알림 + 즉시 respondHook {exitCode:0} (native fallback)
//   stop               → broker.set(idle)
//   session-end        → broker.clear

import { broadcast } from "../../infra/ipc-router";
import { HookRequestSchema } from "../../../shared/claude/status";
import type { ClaudeStatusBroker } from "./status";
import { handlePermissionRequest } from "./permission";

// ---------------------------------------------------------------------------
// 의존성 주입 인터페이스
// ---------------------------------------------------------------------------

/** 워크스페이스 이름 조회 인터페이스 (osc-notification.ts의 WorkspaceNameLookup과 동일 형태) */
export interface WorkspaceNameLookup {
  getName(id: string): string | null;
}

/** agentHost에서 필요한 메서드만 추출 */
export interface HookAgentHost {
  on(event: string, cb: (args: unknown) => void): () => void;
}

/**
 * claude.respondHook 을 호출하기 위해 workspaceId별 AgentChannel을 제공하는 인터페이스.
 * WorkspaceManager.tryGetAgentChannel 을 wrapping한다.
 */
export interface HookChannelProvider {
  tryGetAgentChannel(workspaceId: string): Promise<import("../../infra/agent/channel").AgentChannel | null>;
}

export interface HookHandlerDeps {
  broker: ClaudeStatusBroker;
  agentHost: HookAgentHost;
  channelProvider: HookChannelProvider;
  workspaceManager: WorkspaceNameLookup;
  /** 앱이 포커스 상태인지 확인 — 비포커스 시 OS 알림 발사. */
  getFocusedWindow: () => import("electron").BrowserWindow | null;
  /** OS 알림 생성자 — 테스트 주입용. 미제공 시 lazy require로 Electron Notification 사용. */
  electronNotificationCtor?: typeof import("electron").Notification;
  /**
   * broadcast 함수 주입 — 테스트용. 미제공 시 ipc-router의 broadcast 사용.
   */
  broadcastFn?: (channel: string, event: string, args: unknown) => void;
  /**
   * 워크스페이스 활성화 콜백 — 알림 클릭 시 호출.
   */
  activateWorkspace?: (workspaceId: string) => Promise<void>;
  /** 앱 창 포커스 콜백 — 알림 클릭 시 호출. */
  focusMainWindow?: () => void;
}

// ---------------------------------------------------------------------------
// Notification payload 헬퍼
// ---------------------------------------------------------------------------

/**
 * Claude Code Notification hook payload에서 message 필드를 추출한다.
 * spec상 message 필드만 신뢰한다(T1 확정).
 */
function extractNotificationMessage(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  return typeof p.message === "string" ? p.message : undefined;
}

/**
 * Claude Code PermissionRequest hook payload에서 tool_name을 추출한다.
 */
function extractToolName(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  return typeof p.tool_name === "string" ? p.tool_name : undefined;
}

// ---------------------------------------------------------------------------
// OS 알림 발사 헬퍼
// ---------------------------------------------------------------------------

/**
 * OS 알림을 발사하거나(비포커스 시) in-app broadcast를 보낸다(포커스 시).
 * osc-notification.ts의 fireOsNotification / handleChunk 패턴과 동일한 구조.
 */
function fireClaudeNotification(
  workspaceId: string,
  tabId: string,
  title: string,
  body: string,
  deps: HookHandlerDeps,
): void {
  const broadcastFn = deps.broadcastFn ?? broadcast;
  const focusedWindow = deps.getFocusedWindow();
  const isAppFocused = focusedWindow !== null && !focusedWindow.isMinimized();

  if (isAppFocused) {
    // 앱이 포커스 상태 — OS 알림 생략, in-app 표시용 broadcast만 발사.
    broadcastFn("pty", "notificationClick", { workspaceId, tabId });
    return;
  }

  const NotificationCtor =
    deps.electronNotificationCtor ??
    (require("electron") as typeof import("electron")).Notification;

  const n = new NotificationCtor({ title, body });
  n.on("click", () => {
    deps.focusMainWindow?.();
    deps.activateWorkspace?.(workspaceId)?.catch((err: unknown) => {
      console.warn("[claude-hook] activateWorkspace failed:", err);
    });
    broadcastFn("pty", "notificationClick", { workspaceId, tabId });
  });
  n.show();
}

// ---------------------------------------------------------------------------
// hook 이벤트 처리
// ---------------------------------------------------------------------------

/**
 * 단일 "claude.hook" 이벤트 페이로드를 처리한다.
 */
async function handleHookEvent(payload: unknown, deps: HookHandlerDeps): Promise<void> {
  const parsed = HookRequestSchema.safeParse(payload);
  if (!parsed.success) return;

  const { hookId, workspaceId, tabId, subcommand } = parsed.data;
  const hookPayload = parsed.data.payload;

  const { broker } = deps;

  switch (subcommand) {
    case "session-start": {
      // 세션 시작 — running 상태로 전환.
      broker.set(workspaceId, tabId, "running");
      break;
    }

    case "user-prompt-submit": {
      // 사용자 프롬프트 제출 — running, 기존 알림 인디케이터 제거.
      broker.set(workspaceId, tabId, "running");
      // in-app 표시용 notificationClick broadcast로 기존 attention indicator 해제.
      (deps.broadcastFn ?? broadcast)("pty", "notificationClick", { workspaceId, tabId });
      break;
    }

    case "pre-tool-use": {
      // 도구 실행 직전 — running 전환 후 즉시 응답(async hook).
      broker.set(workspaceId, tabId, "running");
      // async:true hook은 즉시 exitCode:0으로 응답해야 Claude가 진행할 수 있다.
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "notification": {
      // Claude Code 알림 — needsInput + message 전환 + OS 알림 발사.
      const message = extractNotificationMessage(hookPayload);
      broker.set(workspaceId, tabId, "needsInput", message);

      const workspaceName = deps.workspaceManager.getName(workspaceId) ?? "Terminal";
      const title = `[${workspaceName}] Claude`;
      const body = message ?? "Needs your attention";
      fireClaudeNotification(workspaceId, tabId, title, body, deps);
      break;
    }

    case "permission-request": {
      // 권한 요청 — permissionPending + OS 알림 후 즉시 exit 0 (native PTY fallback).
      const toolName = extractToolName(hookPayload);
      const message = toolName
        ? `Claude needs permission: ${toolName}`
        : "Claude needs permission";
      broker.set(workspaceId, tabId, "permissionPending", message);

      const workspaceName = deps.workspaceManager.getName(workspaceId) ?? "Terminal";
      const title = `[${workspaceName}] Permission Required`;
      const body = message;
      fireClaudeNotification(workspaceId, tabId, title, body, deps);

      // 1차: 즉시 exit 0 응답으로 native PTY prompt fallback 유도.
      // TODO(후속 PR): modal UI 결정 후 allow/deny 응답.
      const response = handlePermissionRequest();
      await respondHook(deps.channelProvider, workspaceId, hookId, response);
      break;
    }

    case "stop": {
      // Claude 응답 완료 — idle 전환, 알림 인디케이터 해제.
      broker.set(workspaceId, tabId, "idle");
      (deps.broadcastFn ?? broadcast)("pty", "notificationClick", { workspaceId, tabId });
      break;
    }

    case "session-end": {
      // 세션 종료 — 항목 제거.
      broker.clear(workspaceId, tabId);
      break;
    }

    default:
      // 알 수 없는 subcommand — 무시(Claude Code 업데이트로 새 이벤트가 추가될 수 있음).
      break;
  }
}

/**
 * workspaceId의 AgentChannel을 통해 claude.respondHook dispatch 메서드를 호출한다.
 * 실패 시 경고 로그만 남기고 진행한다 — Claude Code의 timeout fallback에 맡긴다.
 */
async function respondHook(
  channelProvider: HookChannelProvider,
  workspaceId: string,
  hookId: string,
  response: { stdout?: string; exitCode?: number },
): Promise<void> {
  try {
    const channel = await channelProvider.tryGetAgentChannel(workspaceId);
    if (!channel) {
      console.warn(`[claude-hook] respondHook: channel not found for workspace=${workspaceId}`);
      return;
    }
    await channel.call("claude.respondHook", { hookId, response });
  } catch (err) {
    console.warn(`[claude-hook] respondHook failed for hookId=${hookId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// 공개 wiring 함수
// ---------------------------------------------------------------------------

/**
 * agentHost에 "claude.hook" 이벤트 구독을 등록한다.
 *
 * setupClaudeFeature에서 1회 호출한다.
 * 반환값은 구독 해제 함수다.
 */
export function registerHookHandler(deps: HookHandlerDeps): () => void {
  return deps.agentHost.on("claude.hook", (payload) => {
    handleHookEvent(payload, deps).catch((err: unknown) => {
      console.warn("[claude-hook] handleHookEvent error:", err);
    });
  });
}
