// Claude Code hook 이벤트 핸들러.
//
// Go agent의 hookserver가 "claude.hook" 이벤트를 push하면 이 모듈이 수신해
// subcommand별 상태 전이 + OS 알림 발사 + agentHost respondHook 호출을 처리한다.
//
// 설계 원칙:
//  1. 모든 subcommand에서 broker 처리 직후 즉시 respondHook을 호출해 hook
//     프로세스를 해제한다. wrapper의 settings JSON이 6개 훅을 async:true로
//     잡아 claude는 응답을 기다리지 않지만, hookclient 프로세스 자체를 빨리
//     종료시키기 위해 응답을 보낸다(자원 정리). PermissionRequest만 sync 유지.
//  2. OS 알림 발사 기준은 **사용자가 그 탭을 보고 있는지**로 통일한다
//     (앱 포커스 + ActiveContextStore.isActive). 멀티 워크스페이스/멀티 탭
//     환경에서는 앱 포커스만으로는 부족하다 — 사용자가 워크스페이스 A에 있을
//     때 워크스페이스 B의 알림은 받아야 한다.
//
// subcommand 매핑:
//   session-start      → broker.set(idle) + respondHook — 입력 대기, 글리프 없음
//   user-prompt-submit → broker.set(running) + respondHook
//   pre-tool-use       → broker.set(running) + respondHook
//   notification       → broker.set(needsInput) + (그 탭 안 보면) OS 알림 + respondHook
//   permission-request → broker.set(permissionPending) + (그 탭 안 보면) OS 알림 + respondHook (sync, native fallback)
//   stop               → 그 탭 보면 idle 직행 / 아니면 completed + OS 알림 + respondHook
//   session-end        → broker.clear + respondHook

import { broadcast } from "../../infra/ipc-router";
import { HookRequestSchema } from "../../../shared/claude/status";
import type { ClaudeStatusBroker } from "./status";
import type { ActiveContextStore } from "./active-context";
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
  /** 사용자가 현재 보고 있는 (workspaceId, tabId) 컨텍스트 — Stop 알림 발사 결정에 사용. */
  activeContext: ActiveContextStore;
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
  /**
   * OS 알림 마스터 토글 getter — 사용자가 Settings에서 끈 경우 false.
   * 매 호출마다 평가하므로 토글 변경이 즉시 반영된다. 미제공 시(기본) 항상 true.
   * 발사 직전에 검사하므로 in-app status broker(사이드바 인디케이터)는 영향받지 않는다.
   */
  notificationsEnabled?: () => boolean;
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
 * 발사된 Electron Notification 객체에 대한 strong reference 유지용 Set.
 *
 * Electron Notification은 main 프로세스 객체로, show() 직후 reference가
 * 끊기면 GC가 회수해 OS 알림이 즉시 dropped되는 케이스가 있다 (특히 macOS).
 * close/click 이벤트가 발사될 때까지 Set에 보관해 GC를 막는다.
 *
 * 사용 패턴: 알림 생성 직후 add → close 이벤트에서 delete.
 */
const pendingNotifications = new Set<import("electron").Notification>();

/**
 * Notification 객체를 pendingNotifications에 등록하고 close 시 자동 제거한다.
 * 테스트 환경에서 close 이벤트를 발사하지 않는 fake에 대비해 fail-safe로
 * 5분 후 강제 제거 timeout도 함께 설정한다.
 */
function trackNotification(n: import("electron").Notification): void {
  pendingNotifications.add(n);
  const cleanup = () => {
    pendingNotifications.delete(n);
  };
  // close — OS가 알림을 dismiss하거나 사용자가 닫았을 때.
  // ts: Notification은 EventEmitter라 on 호출 시그니처가 유연하다.
  (n as unknown as { on(event: string, cb: () => void): void }).on("close", cleanup);
  // click도 발사되면 close 직전에 함께 cleanup해 둔다 (이벤트 순서 무관).
  (n as unknown as { on(event: string, cb: () => void): void }).on("click", cleanup);
  // 안전 timeout — 위 두 이벤트가 모두 안 와도 5분 후 reference 해제.
  setTimeout(cleanup, 5 * 60 * 1000).unref?.();
}

/**
 * OS 알림을 무조건 발사한다. 호출자가 미리 "사용자가 그 탭을 보고 있지 않다"는
 * 조건을 확인한 뒤 호출해야 한다 (isViewingThisTab === false).
 *
 * 클릭 시: 메인 창 포커스 + 워크스페이스 활성화 + 그 탭으로 점프
 * (notificationClick broadcast — OS 알림 클릭의 정당한 용도).
 */
function fireOsNotification(
  workspaceId: string,
  tabId: string,
  title: string,
  body: string,
  deps: HookHandlerDeps,
): void {
  // 사용자 마스터 토글 가드. in-app status broker(글리프/카드)는 이미 호출자에서
  // 처리되었으므로, 여기서만 막아도 sidebar attention 등 시각 피드백은 정상.
  // 사이드바·탭 인디케이터 ↔ OS 알림이 분리 제어되는 의도된 설계다.
  if (deps.notificationsEnabled !== undefined && !deps.notificationsEnabled()) {
    return;
  }

  const broadcastFn = deps.broadcastFn ?? broadcast;
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
  trackNotification(n);
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

  // 공통 — 사용자가 현재 이 탭을 보고 있는지.
  // 알림 발사가 필요한 모든 훅(Notification/PermissionRequest/Stop)이 동일 기준을 쓴다.
  // 멀티 워크스페이스 + 멀티 탭 환경이므로 앱 포커스만으로는 부족하다.
  const focused = deps.getFocusedWindow();
  const isAppFocused = focused !== null && !focused.isMinimized();
  const isViewingThisTab =
    isAppFocused && deps.activeContext.isActive(workspaceId, tabId);
  const workspaceName = deps.workspaceManager.getName(workspaceId) ?? "Terminal";

  switch (subcommand) {
    case "session-start": {
      // 세션 시작 — Claude가 사용자 입력 대기 상태로 들어간다. 실제 동작이
      // 시작되는 시점은 user-prompt-submit이므로 SessionStart는 running이
      // 아니다. broker에 entry는 만들어 두되 idle로 두면 글리프는 안 보이고
      // (idle 글리프는 null), 첫 프롬프트 제출 시 running으로 자연 전이된다.
      broker.set(workspaceId, tabId, "idle");
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "user-prompt-submit": {
      // 사용자 프롬프트 제출 — running 전환 후 즉시 응답(async hook).
      // (이전에 있던 notificationClick broadcast는 yank back 버그 원인이라 제거.
      // attention indicator 해제는 broker.set의 status 변경이 처리한다.)
      broker.set(workspaceId, tabId, "running");
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "pre-tool-use": {
      // 도구 실행 직전 — running 전환 후 즉시 응답(async hook).
      broker.set(workspaceId, tabId, "running");
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "notification": {
      // Claude Code 알림 — needsInput + message 전환.
      // 사용자가 그 탭을 보고 있지 않으면 OS 알림 발사.
      const message = extractNotificationMessage(hookPayload);
      broker.set(workspaceId, tabId, "needsInput", message);

      if (!isViewingThisTab) {
        const title = `[${workspaceName}] Claude`;
        const body = message ?? "Needs your attention";
        fireOsNotification(workspaceId, tabId, title, body, deps);
      }
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "permission-request": {
      // 권한 요청 — permissionPending + 사용자가 그 탭을 보고 있지 않으면 OS 알림.
      // 즉시 exit 0으로 native PTY prompt fallback 유도.
      const toolName = extractToolName(hookPayload);
      const message = toolName
        ? `Claude needs permission: ${toolName}`
        : "Claude needs permission";
      broker.set(workspaceId, tabId, "permissionPending", message);

      if (!isViewingThisTab) {
        const title = `[${workspaceName}] Permission Required`;
        fireOsNotification(workspaceId, tabId, title, message, deps);
      }

      // 1차: 즉시 exit 0 응답으로 native PTY prompt fallback 유도.
      // TODO(후속 PR): modal UI 결정 후 allow/deny 응답.
      const response = handlePermissionRequest();
      await respondHook(deps.channelProvider, workspaceId, hookId, response);
      break;
    }

    case "stop": {
      // Claude 응답 완료 — 분기:
      //  - 사용자가 그 탭을 보고 있으면: idle로 직행 (이미 보고 있으니 알림/인디케이터 모두 불필요).
      //  - 그렇지 않으면: completed 전이 + OS 알림 발사. 사용자가 탭을 활성화하면
      //    markSeen IPC로 idle 전이된다.
      //
      // assistantText는 hookclient가 같은 호스트에서 transcript_path를 직접 읽어
      // 추출해 둔 마지막 assistant 메시지(단일 줄, 최대 500자). 비어있을 수 있다
      // (transcript 없음/파싱 실패 등 silent fallback) — 그 경우 사이드바는
      // 글리프만 표시된다.
      const assistantText = parsed.data.assistantText;

      if (isViewingThisTab) {
        broker.set(workspaceId, tabId, "idle");
      } else {
        broker.set(workspaceId, tabId, "completed", assistantText);
        const title = `[${workspaceName}] Claude`;
        // OS 알림은 짧은 본문이 적합 — 응답 미리보기가 있으면 그것을, 없으면
        // 정적 텍스트를 보낸다. 사이드바 카드는 카드 자체 컷(50자)으로 다시 자른다.
        const body =
          assistantText !== undefined && assistantText !== ""
            ? assistantText
            : "Response complete";
        fireOsNotification(workspaceId, tabId, title, body, deps);
      }
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "session-end": {
      // 세션 종료 — 항목 제거 후 즉시 응답(async hook).
      broker.clear(workspaceId, tabId);
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
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
