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
//   session-start      → broker.set(idle) + respondHook — 입력 대기, 글리프 없음 (not after compaction)
//   user-prompt-submit → broker.set(running) + respondHook
//   pre-tool-use       → broker.set(running) + respondHook
//                        (a subagent's tool leaves the session's state; see permission-dialogs.ts)
//   notification       → broker.set(needsInput) + (그 탭 안 보면) OS 알림 + respondHook
//                        (a permission dialog's notification keeps or sets permissionPending;
//                        one that only tells something, as a login or a push, only notifies)
//   permission-request → broker.set(permissionPending) + (그 탭 안 보면) OS 알림; held for an
//                        answer from the sessions tab (permission-asks.ts) beside Claude Code's
//                        own dialog, or, for a `claude -p` run, respondHook at once (native fallback)
//   post-tool-use      → the tool waiting on the permission ran: permissionPending → running + respondHook
//   post-tool-use-failure → as post-tool-use, for a tool that failed as it ran
//   subagent-start     → respondHook (the sessions tab's record only)
//   subagent-stop      → the subagent's permission dialogs are over + respondHook
//   stop               → 그 탭 보면 idle 직행 / 아니면 completed + OS 알림 + respondHook
//   stop-failure       → an API error ended the turn instead: error + (그 탭 안 보면) OS 알림 + respondHook
//   session-end        → broker.clear + respondHook
//
// Turn hooks of a turn already over (by prompt_id, see turn-order.ts) are only answered.
// Every other hook is told to deps.activity, the record the sessions tab shows.

import type { PermissionAnswer } from "../../../shared/claude/activity";
import {
  type ClaudeStatus,
  HookGoneSchema,
  HookRequestSchema,
  type HookResponse,
  PROMPT_MAX_CHARS,
} from "../../../shared/claude/status";
import { createLogger } from "../../../shared/log/main";
import { tryGetMainT } from "../../i18n";
import { broadcast } from "../../infra/ipc-router";
import type { ActiveContextStore } from "./active-context";
import { handlePermissionRequest } from "./permission";
import type { AnsweredAsk, PermissionAsks } from "./permission-asks";
import { MAIN_AGENT, PermissionDialogs } from "./permission-dialogs";
import type { SessionActivityLog } from "./session-activity";
import type { ClaudeStatusBroker } from "./status";
import { TurnOrder } from "./turn-order";

const log = createLogger("claude-hook");

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
  tryGetAgentChannel(
    workspaceId: string,
  ): Promise<import("../../infra/agent/channel").AgentChannel | null>;
}

export interface HookHandlerDeps {
  broker: ClaudeStatusBroker;
  /** Records the tools, todos and agents the hooks tell of. */
  activity?: SessionActivityLog;
  /** Holds permission requests for an answer from the sessions tab. */
  asks?: PermissionAsks;
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
 * Notification types Claude Code sends while a permission dialog is open; the
 * session is waiting on a permission, not on an answer.
 */
const PERMISSION_NOTIFICATION_TYPES = new Set(["permission_prompt", "worker_permission_prompt"]);

function isPermissionNotification(payload: unknown): boolean {
  return PERMISSION_NOTIFICATION_TYPES.has(notificationType(payload) ?? "");
}

/**
 * Notification types that only tell the user something: a login, a message
 * Claude pushed, an agent of the session done, a model or quota change. Claude
 * Code sends them in the middle of a turn too, and the session is not waiting
 * on the user for them. Every other type (idle_prompt, elicitation_dialog,
 * agent_needs_input, …), and one Claude Code does not name, is.
 */
const INFORMATIONAL_NOTIFICATION_TYPES = new Set([
  "auth_success",
  "auth_storage_failure",
  "agent_completed",
  "push_notification",
  "computer_use_enter",
  "computer_use_exit",
  "quota_auto_resume_fired",
  "quota_auto_resume_stale",
  "quota_auto_resume_disabled",
  "model_refusal_fallback",
  "plugin_notification",
  "elicitation_complete",
  "elicitation_response",
]);

function isInformationalNotification(payload: unknown): boolean {
  return INFORMATIONAL_NOTIFICATION_TYPES.has(notificationType(payload) ?? "");
}

function notificationType(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const type = (payload as Record<string, unknown>).notification_type;
  return typeof type === "string" ? type : undefined;
}

/**
 * The envelopes of turns Claude Code starts on its own: a background task
 * that finished, a message from another Claude session or a teammate, an
 * event from a channel or a schedule, a prompt a plugin submits.
 * UserPromptSubmit runs for them too, with the envelope as the prompt. The
 * tags are the ones Claude Code 2.1 marks as not from the user; a message
 * from another session can come framed by a line instead of a tag.
 */
const SYSTEM_TURN = new RegExp(
  [
    "^<(?:task-notification|cross-session-message|teammate-message|agent-message|channel|tick",
    "|remote-review|slack-ping|slack-tag-message|coordinator-relay|system-reminder)[\\s>]",
    "|^(?:Another Claude session|A peer session) sent a message(?: while you were working)?:",
    "|^The [^\\n]+ plugin sent a message:\\n",
  ].join(""),
);

/** Text the user pasted, as Claude Code marks it when it expands a collapsed paste. */
const PASTED = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g;

/**
 * Claude Code UserPromptSubmit hook payload에서 prompt를 추출한다.
 * 붙여넣은 파일 전체가 들어올 수 있어 PROMPT_MAX_CHARS로 자른다.
 * What the user wrote only: pasted text without Claude Code's marks around
 * it, and nothing for a turn Claude Code started itself, which keeps the
 * user's last prompt.
 */
function extractPrompt(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const prompt = (payload as Record<string, unknown>).prompt;
  if (typeof prompt !== "string") return undefined;
  const trimmed = prompt.trim();
  if (trimmed === "" || SYSTEM_TURN.test(trimmed)) return undefined;
  const own = trimmed.replace(PASTED, "$2").trim();
  if (own === "") return undefined;
  return own.length > PROMPT_MAX_CHARS ? `${own.slice(0, PROMPT_MAX_CHARS)}…` : own;
}

/**
 * What a StopFailure hook says ended the turn: the error Claude Code showed,
 * as "API Error: Request rejected (429) · …", else the kind of error, as
 * "rate_limit".
 */
function extractFailure(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  for (const field of [p.last_assistant_message, p.error]) {
    if (typeof field === "string" && field.trim() !== "") return field.trim();
  }
  return undefined;
}

/**
 * How a SessionStart hook's session began: "startup", "resume", "clear",
 * "compact" or "fork".
 */
function sessionStartSource(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const source = (payload as Record<string, unknown>).source;
  return typeof source === "string" ? source : undefined;
}

/**
 * A tool call as PermissionRequest and PostToolUse(Failure) both describe it:
 * its name and input. PermissionRequest carries no tool_use_id to match on.
 */
function toolCall(payload: unknown): string | undefined {
  const name = extractToolName(payload);
  if (name === undefined) return undefined;
  return `${name}\0${JSON.stringify((payload as Record<string, unknown>).tool_input ?? null)}`;
}

/** The subagent a hook ran in, or MAIN_AGENT for the session's own turn. */
function extractAgentId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return MAIN_AGENT;
  const id = (payload as Record<string, unknown>).agent_id;
  return typeof id === "string" ? id : MAIN_AGENT;
}

/**
 * Claude Code PermissionRequest hook payload에서 tool_name을 추출한다.
 */
function extractToolName(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  return typeof p.tool_name === "string" ? p.tool_name : undefined;
}

/** The id of the user prompt a hook belongs to; absent before the first prompt. */
function extractPromptId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = (payload as Record<string, unknown>).prompt_id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** The frames a `claude -p` run inside a session sends of itself (hookclient's print-run). */
const PRINT_FRAMES = new Set([
  "print-start",
  "print-init",
  "print-tool-use",
  "print-tool-result",
  "print-end",
]);

/** Hooks that belong to a turn, and so can arrive after it is over. */
const TURN_HOOKS = new Set([
  "user-prompt-submit",
  "pre-tool-use",
  "notification",
  "permission-request",
  "stop",
  "stop-failure",
]);

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
      log.warn(`activateWorkspace failed: ${(err as Error).message}`);
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
async function handleHookEvent(
  payload: unknown,
  deps: HookHandlerDeps,
  turns: TurnOrder,
  dialogs: PermissionDialogs,
): Promise<void> {
  const parsed = HookRequestSchema.safeParse(payload);
  if (!parsed.success) return;

  const { hookId, workspaceId, tabId, subcommand } = parsed.data;
  const hookPayload = parsed.data.payload;

  const { broker } = deps;

  // A `claude -p` run started inside the session tells of itself (hookclient's
  // print-run), for the sessions tab only: the session's own state is its turn's.
  if (PRINT_FRAMES.has(subcommand)) {
    deps.activity?.notePrint(workspaceId, tabId, subcommand, hookPayload);
    await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
    return;
  }

  // A frame of a turn the session has moved past — a Stop or an idle
  // Notification that lost the race to the next prompt — changes nothing and
  // notifies no one: the tab is busy with the next turn. The hook is still
  // answered, PermissionRequest as usual since Claude Code waits on it.
  if (
    TURN_HOOKS.has(subcommand) &&
    turns.isStale(workspaceId, tabId, subcommand, extractPromptId(hookPayload))
  ) {
    log.info(`dropped ${subcommand} of a finished turn: workspace=${workspaceId} tab=${tabId}`);
    const response =
      subcommand === "permission-request" ? handlePermissionRequest() : { exitCode: 0 };
    await respondHook(deps.channelProvider, workspaceId, hookId, response);
    return;
  }

  deps.activity?.noteHook(workspaceId, tabId, subcommand, hookPayload);

  // 공통 — 사용자가 현재 이 탭을 보고 있는지.
  // 알림 발사가 필요한 모든 훅(Notification/PermissionRequest/Stop)이 동일 기준을 쓴다.
  // 멀티 워크스페이스 + 멀티 탭 환경이므로 앱 포커스만으로는 부족하다.
  const focused = deps.getFocusedWindow();
  const isAppFocused = focused !== null && !focused.isMinimized();
  const isViewingThisTab = isAppFocused && deps.activeContext.isActive(workspaceId, tabId);
  const t = tryGetMainT();
  const workspaceName =
    deps.workspaceManager.getName(workspaceId) ??
    (t ? t("common:claudeNotification.terminalFallback") : "Terminal");

  const key = `${workspaceId}:${tabId}`;
  const agent = extractAgentId(hookPayload);
  // The dialogs count while the session shows one: an interrupt may have
  // ended the turn they were in.
  if (broker.get(workspaceId, tabId)?.status !== "permissionPending") dialogs.clear(key);

  /**
   * Sets the session's own state. While a permission dialog is open, the
   * session still waits on it: the state is kept to show once it closes, and
   * only a new prompt is shown now.
   */
  const setState = (status: ClaudeStatus, message?: string, prompt?: string | null) => {
    if (!dialogs.isOpen(key)) {
      dialogs.clear(key);
      broker.set(workspaceId, tabId, status, message, prompt);
      return;
    }
    dialogs.setUnder(key, { status, message });
    if (prompt !== undefined) {
      const notice = broker.get(workspaceId, tabId)?.notice;
      broker.set(workspaceId, tabId, "permissionPending", notice, prompt);
    }
  };

  /** A dialog closed: once none is open, the session shows its state again. */
  const afterClose = () => {
    const under = dialogs.takeUnder(key);
    if (!under) return;
    // On the tab the user looks at, a turn that ended or a question asked
    // while the dialog was up is seen, as when it comes.
    if (isViewingThisTab && under.status === "completed") {
      broker.set(workspaceId, tabId, "idle", under.message);
    } else if (isViewingThisTab && under.status === "needsInput") {
      broker.set(workspaceId, tabId, "idle");
    } else {
      broker.set(workspaceId, tabId, under.status, under.message);
    }
  };

  switch (subcommand) {
    case "session-start": {
      // 세션 시작 — Claude가 사용자 입력 대기 상태로 들어간다. 실제 동작이
      // 시작되는 시점은 user-prompt-submit이므로 SessionStart는 running이
      // 아니다. broker에 entry는 만들어 두되 idle로 두면 글리프는 안 보이고
      // (idle 글리프는 null), 첫 프롬프트 제출 시 running으로 자연 전이된다.
      // 새 세션이라 이전 세션의 프롬프트는 지운다.
      // Compaction starts no session: it can run in the middle of a turn,
      // which goes on after it with the same prompt.
      if (sessionStartSource(hookPayload) !== "compact") {
        dialogs.clear(key);
        broker.set(workspaceId, tabId, "idle", undefined, null);
      }
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "user-prompt-submit": {
      // 사용자 프롬프트 제출 — running 전환 후 즉시 응답(async hook).
      // (이전에 있던 notificationClick broadcast는 yank back 버그 원인이라 제거.
      // attention indicator 해제는 broker.set의 status 변경이 처리한다.)
      // 프롬프트는 세션 보기가 "무엇을 하고 있는지" 보여주도록 함께 둔다.
      // A new turn: the session's own dialogs are over, a subagent's may not be.
      dialogs.closeAgent(key, MAIN_AGENT);
      setState("running", undefined, extractPrompt(hookPayload));
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "pre-tool-use": {
      // 도구 실행 직전 — running 전환 후 즉시 응답(async hook).
      // An agent that starts another tool is past its dialogs for other calls,
      // answered or denied. Its dialog for this call may still be open: this
      // hook runs async, and can come after the PermissionRequest it led to.
      const closed = dialogs.closeOthers(key, agent, toolCall(hookPayload));
      // A subagent works beside the session's turn, and on after it: the
      // session's own state is told by its own hooks and the turn Claude Code
      // starts once the subagent is done.
      if (agent === MAIN_AGENT) setState("running");
      else if (closed) afterClose();
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "notification": {
      // Claude Code 알림 — needsInput + message 전환.
      // 사용자가 그 탭을 보고 있지 않으면 OS 알림 발사.
      const message = extractNotificationMessage(hookPayload);
      if (isPermissionNotification(hookPayload)) {
        // The dialog's own notification: PermissionRequest usually came first
        // and already set the state and notified, so it is kept as it is.
        const current = broker.get(workspaceId, tabId)?.status;
        if (current !== "permissionPending") {
          // Whose dialog it is is not told; the PermissionRequest that comes
          // with it, if late, takes its place.
          dialogs.open(key, MAIN_AGENT, undefined, { status: current ?? "running" });
          broker.set(workspaceId, tabId, "permissionPending", message);
          if (!isViewingThisTab) {
            const title = `[${workspaceName}] ${t ? t("common:claudeNotification.permissionRequired") : "Permission Required"}`;
            const body =
              message ??
              (t ? t("common:claudeNotification.needsPermission") : "Claude needs permission");
            fireOsNotification(workspaceId, tabId, title, body, deps);
          }
        }
        await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
        break;
      }
      if (isInformationalNotification(hookPayload)) {
        // Told, not asked: the session's state stays as it is, so a turn under
        // way still reads running and a wait on it goes on.
        if (!isViewingThisTab && message) {
          fireOsNotification(workspaceId, tabId, `[${workspaceName}] Claude`, message, deps);
        }
        await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
        break;
      }
      // 사용자가 그 탭을 보고 있으면 Stop처럼 idle로 둔다 — 이미 보고 있으니
      // 글리프와 inbox 항목이 남을 이유가 없다 (보지 않을 때 생긴 needsInput은
      // 탭을 보면 markSeen이 idle로 돌린다).
      // The dialog on the screen now, if any, is not a permission's.
      dialogs.clear(key);
      if (isViewingThisTab) {
        broker.set(workspaceId, tabId, "idle");
      } else {
        broker.set(workspaceId, tabId, "needsInput", message);
        const title = `[${workspaceName}] Claude`;
        const body =
          message ?? (t ? t("common:claudeNotification.needsAttention") : "Needs your attention");
        fireOsNotification(workspaceId, tabId, title, body, deps);
      }
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "permission-request": {
      // 권한 요청 — permissionPending + 사용자가 그 탭을 보고 있지 않으면 OS 알림.
      const toolName = extractToolName(hookPayload);
      const message = toolName
        ? t
          ? t("common:claudeNotification.needsPermissionTool", { tool: toolName })
          : `Claude needs permission: ${toolName}`
        : t
          ? t("common:claudeNotification.needsPermission")
          : "Claude needs permission";
      const current = broker.get(workspaceId, tabId)?.status;
      dialogs.open(key, agent, toolCall(hookPayload), {
        status: current === undefined || current === "permissionPending" ? "running" : current,
      });
      broker.set(workspaceId, tabId, "permissionPending", message);

      if (!isViewingThisTab) {
        const title = `[${workspaceName}] ${t ? t("common:claudeNotification.permissionRequired") : "Permission Required"}`;
        fireOsNotification(workspaceId, tabId, title, message, deps);
      }

      // Held for an answer from the sessions tab while Claude Code shows its
      // own dialog. A `claude -p` run shows none and waits on the hook, so it
      // gets the native fallback at once.
      if (deps.asks && !parsed.data.print) {
        deps.asks.hold(workspaceId, tabId, hookId, agent, toolCall(hookPayload), hookPayload);
      } else {
        await respondHook(deps.channelProvider, workspaceId, hookId, handlePermissionRequest());
      }
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
      // The answer replaces the last turn's, even when this turn gave none,
      // and stays once the user has seen it.
      const answer = assistantText ?? "";

      // The turn's dialogs are over; a subagent's may still be open.
      dialogs.closeAgent(key, MAIN_AGENT);
      if (isViewingThisTab) {
        setState("idle", answer);
      } else {
        setState("completed", answer);
        const title = `[${workspaceName}] Claude`;
        // OS 알림은 짧은 본문이 적합 — 응답 미리보기가 있으면 그것을, 없으면
        // 정적 텍스트를 보낸다. 사이드바 카드는 카드 자체 컷(50자)으로 다시 자른다.
        const body =
          assistantText !== undefined && assistantText !== ""
            ? assistantText
            : t
              ? t("common:claudeNotification.responseComplete")
              : "Response complete";
        fireOsNotification(workspaceId, tabId, title, body, deps);
      }
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "stop-failure": {
      // An API error (a rate limit, an overloaded or failed request, …)
      // ended the turn, and Claude Code ran this in place of Stop. The
      // session waits on the user to try again, viewed or not.
      const failure = extractFailure(hookPayload);
      const message =
        failure ?? (t ? t("common:claudeNotification.turnFailed") : "Claude stopped on an error");
      // The turn's dialogs are over; a subagent's may still be open.
      dialogs.closeAgent(key, MAIN_AGENT);
      setState("error", message);
      if (!isViewingThisTab) {
        fireOsNotification(workspaceId, tabId, `[${workspaceName}] Claude`, message, deps);
      }
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "post-tool-use":
    case "post-tool-use-failure": {
      // A tool ran, or failed as it ran. Once the user allows a tool, no other
      // hook of its agent runs until it ends, so its end is what closes the
      // dialog. Only that dialog closes: a tool run beside it does not, and a
      // late hook leaves the turn's end as it is.
      if (dialogs.closeCall(key, agent, toolCall(hookPayload))) afterClose();
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "subagent-start": {
      // Told for the sessions tab only (deps.activity, above).
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "subagent-stop": {
      // The subagent ended: no dialog of it is open, answered or not.
      if (dialogs.closeAgent(key, agent)) afterClose();
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "session-end": {
      // 세션 종료 — 항목 제거 후 즉시 응답(async hook).
      turns.end(workspaceId, tabId);
      dialogs.clear(key);
      broker.clear(workspaceId, tabId);
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    default:
      // 알 수 없는 subcommand — 무시(Claude Code 업데이트로 새 이벤트가 추가될 수 있음).
      break;
  }

  // A request whose dialog closed was answered in the terminal, or is past.
  deps.asks?.retain(workspaceId, tabId, (asker, call) => dialogs.isOpenFor(key, asker, call));
}

/**
 * The user answered a held permission request from the sessions tab: its
 * dialog is closed, and the agent that asked goes on. Stopping the turn
 * leaves the session waiting on the user, as an interrupt does.
 */
function afterAnswer(
  ask: AnsweredAsk,
  answer: PermissionAnswer,
  deps: HookHandlerDeps,
  dialogs: PermissionDialogs,
): void {
  const { workspaceId, tabId, agent, call } = ask;
  const key = `${workspaceId}:${tabId}`;
  const stops = answer === "denyStop";
  deps.activity?.noteAnswered(
    workspaceId,
    tabId,
    agent === MAIN_AGENT ? undefined : agent,
    ask.tool,
    ask.target,
    answer === "deny" || stops,
  );
  const closed = stops ? dialogs.closeAgent(key, MAIN_AGENT) : dialogs.closeCall(key, agent, call);
  if (stops) dialogs.setUnder(key, { status: "idle" });
  if (!closed) return;
  const under = dialogs.takeUnder(key);
  if (under) deps.broker.set(workspaceId, tabId, under.status, under.message);
}

/**
 * The user answered a held request's dialog in the terminal. No hook tells
 * of it until the call allowed ends, which can be long: its dialog is closed
 * now, and the agent that asked goes on. A "No" there interrupts the turn,
 * which the terminal's interrupt watch tells.
 */
function afterTerminalAnswer(
  ask: AnsweredAsk,
  deps: HookHandlerDeps,
  dialogs: PermissionDialogs,
): void {
  const { workspaceId, tabId, agent, call } = ask;
  const key = `${workspaceId}:${tabId}`;
  deps.activity?.noteAnswered(
    workspaceId,
    tabId,
    agent === MAIN_AGENT ? undefined : agent,
    ask.tool,
    ask.target,
    false,
  );
  if (!dialogs.closeCall(key, agent, call)) return;
  const under = dialogs.takeUnder(key);
  if (under) deps.broker.set(workspaceId, tabId, under.status, under.message);
}

/**
 * workspaceId의 AgentChannel을 통해 claude.respondHook dispatch 메서드를 호출한다.
 * 실패 시 경고 로그만 남기고 진행한다 — Claude Code의 timeout fallback에 맡긴다.
 */
async function respondHook(
  channelProvider: HookChannelProvider,
  workspaceId: string,
  hookId: string,
  response: HookResponse,
): Promise<void> {
  await answerHook(channelProvider, workspaceId, hookId, response);
}

/**
 * Answers the waiting hook `hookId` through its workspace's agent: false when
 * it could not, as when the hook no longer waits.
 */
export async function answerHook(
  channelProvider: HookChannelProvider,
  workspaceId: string,
  hookId: string,
  response: HookResponse,
): Promise<boolean> {
  try {
    const channel = await channelProvider.tryGetAgentChannel(workspaceId);
    if (!channel) {
      log.warn(`respondHook: channel not found for workspace=${workspaceId}`);
      return false;
    }
    await channel.call("claude.respondHook", { hookId, response });
    return true;
  } catch (err) {
    log.warn(`respondHook failed for hookId=${hookId}: ${(err as Error).message}`);
    return false;
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
  const turns = new TurnOrder();
  const dialogs = new PermissionDialogs();
  const offHook = deps.agentHost.on("claude.hook", (payload) => {
    handleHookEvent(payload, deps, turns, dialogs).catch((err: unknown) => {
      log.warn(`handleHookEvent error: ${(err as Error).message}`);
    });
  });
  // A held request's hook ended unanswered: Claude Code ends it as the user
  // interrupts at the dialog, which the terminal's own watch tells.
  const offGone = deps.agentHost.on("claude.hookGone", (payload) => {
    const parsed = HookGoneSchema.safeParse(payload);
    if (parsed.success) deps.asks?.gone(parsed.data.hookId);
  });
  const offAnswered = deps.asks?.onAnswered((ask, answer) => {
    afterAnswer(ask, answer, deps, dialogs);
  });
  const offTerminal = deps.asks?.onAnsweredInTerminal((ask) => {
    afterTerminalAnswer(ask, deps, dialogs);
  });
  return () => {
    offHook();
    offGone();
    offAnswered?.();
    offTerminal?.();
  };
}
