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
import { showDesktopNotification } from "../../infra/platform/desktop-notifications";
import type { ActiveContextStore } from "./active-context";
import type { ChatAnswers } from "./chat-answers";
import { handlePermissionRequest } from "./permission";
import type { AnsweredAsk, HookAnswerResult, PermissionAsks } from "./permission-asks";
import { MAIN_AGENT, PermissionDialogs } from "./permission-dialogs";
import type { SessionActivityLog } from "./session-activity";
import type { ClaudeStatusBroker } from "./status";
import { TurnOrder } from "./turn-order";

const log = createLogger("claude-hook");

export interface WorkspaceNameLookup {
  getName(id: string): string | null;
}

export interface HookAgentHost {
  on(event: string, cb: (args: unknown) => void): () => void;
}

export interface HookChannelProvider {
  tryGetAgentChannel(
    workspaceId: string,
  ): Promise<import("../../infra/agent/channel").AgentChannel | null>;
}

export interface HookHandlerDeps {
  broker: ClaudeStatusBroker;
  activity?: SessionActivityLog;
  asks?: PermissionAsks;
  chatAnswers?: ChatAnswers;
  activeContext: ActiveContextStore;
  agentHost: HookAgentHost;
  channelProvider: HookChannelProvider;
  workspaceManager: WorkspaceNameLookup;
  getFocusedWindow: () => import("electron").BrowserWindow | null;
  electronNotificationCtor?: typeof import("electron").Notification;
  broadcastFn?: (channel: string, event: string, args: unknown) => void;
  connectWorkspace?: (workspaceId: string) => Promise<void>;
  focusMainWindow?: () => void;
  notificationsEnabled?: () => boolean;
}

function extractNotificationMessage(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  return typeof p.message === "string" ? p.message : undefined;
}

const PERMISSION_NOTIFICATION_TYPES = new Set(["permission_prompt", "worker_permission_prompt"]);

function isPermissionNotification(payload: unknown): boolean {
  return PERMISSION_NOTIFICATION_TYPES.has(notificationType(payload) ?? "");
}

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

const SYSTEM_TURN = new RegExp(
  [
    "^<(?:task-notification|cross-session-message|teammate-message|agent-message|channel|tick",
    "|remote-review|slack-ping|slack-tag-message|coordinator-relay|system-reminder)[\\s>]",
    "|^(?:Another Claude session|A peer session) sent a message(?: while you were working)?:",
    "|^The [^\\n]+ plugin sent a message:\\n",
  ].join(""),
);

const PASTED = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g;

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

function extractFailure(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  for (const field of [p.last_assistant_message, p.error]) {
    if (typeof field === "string" && field.trim() !== "") return field.trim();
  }
  return undefined;
}

function sessionStartSource(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const source = (payload as Record<string, unknown>).source;
  return typeof source === "string" ? source : undefined;
}

function toolCall(payload: unknown): string | undefined {
  const name = extractToolName(payload);
  if (name === undefined) return undefined;
  return `${name}\0${JSON.stringify((payload as Record<string, unknown>).tool_input ?? null)}`;
}

function extractAgentId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return MAIN_AGENT;
  const id = (payload as Record<string, unknown>).agent_id;
  return typeof id === "string" ? id : MAIN_AGENT;
}

function extractToolName(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  return typeof p.tool_name === "string" ? p.tool_name : undefined;
}

function extractPromptId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = (payload as Record<string, unknown>).prompt_id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

const PRINT_FRAMES = new Set([
  "print-start",
  "print-init",
  "print-tool-use",
  "print-tool-result",
  "print-text",
  "print-end",
]);

const PRINT_WATCH = "print-watch";

export const PRINT_STOP_ANSWER = "stop";

const TURN_HOOKS = new Set([
  "user-prompt-submit",
  "pre-tool-use",
  "notification",
  "permission-request",
  "stop",
  "stop-failure",
]);

const pendingNotifications = new Set<import("electron").Notification>();

function trackNotification(n: import("electron").Notification): void {
  pendingNotifications.add(n);
  const cleanup = () => {
    clearTimeout(timer);
    pendingNotifications.delete(n);
  };
  const timer = setTimeout(cleanup, 5 * 60 * 1000);
  timer.unref?.();
  (n as unknown as { on(event: string, cb: () => void): void }).on("close", cleanup);
  (n as unknown as { on(event: string, cb: () => void): void }).on("click", cleanup);
}

function fireOsNotification(
  workspaceId: string,
  tabId: string,
  title: string,
  body: string,
  deps: HookHandlerDeps,
): void {
  if (deps.notificationsEnabled !== undefined && !deps.notificationsEnabled()) {
    return;
  }

  const broadcastFn = deps.broadcastFn ?? broadcast;
  const NotificationCtor =
    deps.electronNotificationCtor ??
    (require("electron") as typeof import("electron")).Notification;

  showDesktopNotification(() => {
    const n = new NotificationCtor({ title, body });
    n.on("click", () => {
      deps.focusMainWindow?.();
      deps.connectWorkspace?.(workspaceId)?.catch((err: unknown) => {
        log.warn(`connectWorkspace failed: ${(err as Error).message}`);
      });
      broadcastFn("pty", "notificationClick", { workspaceId, tabId });
    });
    trackNotification(n);
    n.show();
  });
}

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

  if (subcommand === PRINT_WATCH) {
    const runId = (hookPayload as { run_id?: unknown } | undefined)?.run_id;
    if (typeof runId === "string") deps.activity?.notePrintWatch(workspaceId, tabId, runId, hookId);
    return;
  }
  if (PRINT_FRAMES.has(subcommand)) {
    deps.activity?.notePrint(workspaceId, tabId, subcommand, hookPayload);
    await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
    return;
  }

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

  deps.activity?.noteHook(workspaceId, tabId, subcommand, hookPayload, parsed.data.agentMessages);

  const focused = deps.getFocusedWindow();
  const isAppFocused = focused !== null && !focused.isMinimized();
  const isViewingThisTab = isAppFocused && deps.activeContext.isActive(workspaceId, tabId);
  const t = tryGetMainT();
  const workspaceName =
    deps.workspaceManager.getName(workspaceId) ??
    (t ? t("common:claudeNotification.terminalFallback") : "Terminal");

  const key = `${workspaceId}:${tabId}`;
  const agent = extractAgentId(hookPayload);
  if (broker.get(workspaceId, tabId)?.status !== "permissionPending") dialogs.clear(key);

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

  const afterClose = () => {
    const under = dialogs.takeUnder(key);
    if (!under) return;
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
      if (sessionStartSource(hookPayload) !== "compact") {
        dialogs.clear(key);
        broker.set(workspaceId, tabId, "idle", undefined, null);
      }
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "user-prompt-submit": {
      dialogs.closeAgent(key, MAIN_AGENT);
      setState("running", undefined, extractPrompt(hookPayload));
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "pre-tool-use": {
      const closed = dialogs.closeOthers(key, agent, toolCall(hookPayload));
      if (agent === MAIN_AGENT) setState("running");
      else if (closed) afterClose();
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "notification": {
      const message = extractNotificationMessage(hookPayload);
      if (isPermissionNotification(hookPayload)) {
        const current = broker.get(workspaceId, tabId)?.status;
        if (current !== "permissionPending") {
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
        if (!isViewingThisTab && message) {
          fireOsNotification(workspaceId, tabId, `[${workspaceName}] Claude`, message, deps);
        }
        await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
        break;
      }
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

      if (deps.asks && !parsed.data.print) {
        deps.asks.hold(workspaceId, tabId, hookId, agent, toolCall(hookPayload), hookPayload);
      } else {
        await respondHook(deps.channelProvider, workspaceId, hookId, handlePermissionRequest());
      }
      break;
    }

    case "stop": {
      const assistantText = parsed.data.assistantText;
      const answer = assistantText ?? "";

      dialogs.closeAgent(key, MAIN_AGENT);
      if (isViewingThisTab) {
        setState("idle", answer);
      } else {
        setState("completed", answer);
        const title = `[${workspaceName}] Claude`;
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
      const failure = extractFailure(hookPayload);
      const message =
        failure ?? (t ? t("common:claudeNotification.turnFailed") : "Claude stopped on an error");
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
      if (dialogs.closeCall(key, agent, toolCall(hookPayload))) afterClose();
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "subagent-start": {
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "subagent-stop": {
      if (dialogs.closeAgent(key, agent)) afterClose();
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "session-end": {
      turns.end(workspaceId, tabId);
      dialogs.clear(key);
      broker.clear(workspaceId, tabId);
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    default:
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
  }

  deps.asks?.retain(workspaceId, tabId, (asker, call) => dialogs.isOpenFor(key, asker, call));
}

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

function afterChatAnswer(
  workspaceId: string,
  tabId: string,
  stopped: boolean,
  deps: HookHandlerDeps,
  dialogs: PermissionDialogs,
): void {
  const key = `${workspaceId}:${tabId}`;
  if (!dialogs.closeAll(key)) return;
  if (stopped) dialogs.setUnder(key, { status: "idle" });
  const under = dialogs.takeUnder(key);
  if (under) deps.broker.set(workspaceId, tabId, under.status, under.message);
}

async function respondHook(
  channelProvider: HookChannelProvider,
  workspaceId: string,
  hookId: string,
  response: HookResponse,
): Promise<void> {
  await answerHook(channelProvider, workspaceId, hookId, response);
}

export async function answerHook(
  channelProvider: HookChannelProvider,
  workspaceId: string,
  hookId: string,
  response: HookResponse,
): Promise<HookAnswerResult> {
  try {
    const channel = await channelProvider.tryGetAgentChannel(workspaceId);
    if (!channel) {
      log.warn(`respondHook: channel not found for workspace=${workspaceId}`);
      return "unavailable";
    }
    await channel.call("claude.respondHook", { hookId, response });
    return "answered";
  } catch (err) {
    log.warn(`respondHook failed for hookId=${hookId}: ${(err as Error).message}`);
    return (err as { code?: string } | null)?.code === "server.request-failed"
      ? "gone"
      : "unavailable";
  }
}

export function registerHookHandler(
  deps: HookHandlerDeps,
  turns = new TurnOrder(),
  dialogs = new PermissionDialogs(),
): () => void {
  const offHook = deps.agentHost.on("claude.hook", (payload) => {
    handleHookEvent(payload, deps, turns, dialogs).catch((err: unknown) => {
      log.warn(`handleHookEvent error: ${(err as Error).message}`);
    });
  });
  const offGone = deps.agentHost.on("claude.hookGone", (payload) => {
    const parsed = HookGoneSchema.safeParse(payload);
    if (!parsed.success) return;
    const { hookId, workspaceId, tabId, subcommand } = parsed.data;
    if (subcommand === PRINT_WATCH) {
      deps.activity?.notePrint(workspaceId, tabId, "print-gone", parsed.data.payload);
      return;
    }
    deps.asks?.gone(hookId);
  });
  const offAnswered = deps.asks?.onAnswered((ask, answer) => {
    afterAnswer(ask, answer, deps, dialogs);
  });
  const offTerminal = deps.asks?.onAnsweredInTerminal((ask) => {
    afterTerminalAnswer(ask, deps, dialogs);
  });
  const offChat = deps.chatAnswers?.onAnswered((workspaceId, tabId, stopped) => {
    afterChatAnswer(workspaceId, tabId, stopped, deps, dialogs);
  });
  return () => {
    offHook();
    offGone();
    offAnswered?.();
    offTerminal?.();
    offChat?.();
  };
}
