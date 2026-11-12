// Claude Code hook event handler.
//
// When the Go agent's hookserver pushes a "claude.hook" event, this module receives it and, per
// subcommand, handles the state transition, the OS notification and the agentHost respondHook call.
//
// Design principles:
//  1. Every subcommand calls respondHook right after the broker has handled it, so the hook
//     process is released. The wrapper's settings JSON marks six hooks async:true, so claude
//     does not wait for a reply, but the reply is still sent so the hookclient process exits
//     quickly (resource cleanup). Only PermissionRequest stays sync.
//  2. An OS notification fires based on **whether the user is looking at that tab**
//     (app focus + ActiveContextStore.isActive). With several workspaces and tabs, app focus
//     alone is not enough: a user in workspace A must still get workspace B's notifications.
//
// subcommand mapping:
//   session-start      → broker.set(idle) + respondHook — waits for input, no glyph (not after compaction)
//   user-prompt-submit → broker.set(running) + respondHook
//   pre-tool-use       → broker.set(running) + respondHook
//                        (a subagent's tool leaves the session's state; see permission-dialogs.ts)
//   notification       → broker.set(needsInput) + (if the tab is not in view) OS notification + respondHook
//                        (a permission dialog's notification keeps or sets permissionPending;
//                        one that only tells something, as a login or a push, only notifies)
//   permission-request → broker.set(permissionPending) + (if the tab is not in view) OS notification; held for an
//                        answer from the agent list (permission-asks.ts) beside Claude Code's
//                        own dialog, or, for a `claude -p` run, respondHook at once (native fallback)
//   post-tool-use      → the tool waiting on the permission ran: permissionPending → running + respondHook
//   post-tool-use-failure → as post-tool-use, for a tool that failed as it ran
//   subagent-start     → respondHook (the agent list's record only)
//   subagent-stop      → the subagent's permission dialogs are over + respondHook
//   stop               → straight to idle if the tab is in view / else completed + OS notification + respondHook
//   stop-failure       → an API error ended the turn instead: error + (if the tab is not in view) OS notification + respondHook
//   session-end        → broker.clear + respondHook
//
// Turn hooks of a turn already over (by prompt_id, see turn-order.ts) are only answered.
// Every other hook is told to deps.activity, the record the agent list shows.

import type { PermissionAnswer } from "../../../shared/claude/activity";
import {
  type ClaudeStatus,
  HookGoneSchema,
  HookRequestSchema,
  type HookResponse,
  PROMPT_MAX_CHARS,
} from "../../../shared/claude/status";
import { createLogger } from "../../../shared/log/main";
import { isManagerWorkspace } from "../../../shared/manager/manager";
import { tryGetMainT } from "../../i18n";
import { broadcast } from "../../infra/ipc-router";
import { showDesktopNotification } from "../../infra/platform/desktop-notifications";
import type { ActiveContextStore } from "./active-context";
import type { ChatAnswers } from "./chat-answers";
import { handlePermissionRequest } from "./permission";
import type { AnsweredAsk, PermissionAsks } from "./permission-asks";
import { MAIN_AGENT, PermissionDialogs } from "./permission-dialogs";
import type { SessionActivityLog } from "./session-activity";
import type { ClaudeStatusBroker } from "./status";
import { TurnOrder } from "./turn-order";

const log = createLogger("claude-hook");

// ---------------------------------------------------------------------------
// Dependency injection interfaces
// ---------------------------------------------------------------------------

/** Workspace name lookup interface (same shape as WorkspaceNameLookup in osc-notification.ts) */
export interface WorkspaceNameLookup {
  getName(id: string): string | null;
}

/** Only the agentHost methods this module needs */
export interface HookAgentHost {
  on(event: string, cb: (args: unknown) => void): () => void;
}

/**
 * Provides the per-workspaceId AgentChannel needed to call claude.respondHook.
 * Wraps WorkspaceManager.tryGetAgentChannel.
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
  /** Holds permission requests for an answer from the agent list. */
  asks?: PermissionAsks;
  /** Tells of the permission requests a Claude tab's user answered there. */
  chatAnswers?: ChatAnswers;
  /** The (workspaceId, tabId) context the user is looking at — decides whether a Stop notification fires. */
  activeContext: ActiveContextStore;
  agentHost: HookAgentHost;
  channelProvider: HookChannelProvider;
  workspaceManager: WorkspaceNameLookup;
  /** Whether the app has focus — when it does not, an OS notification fires. */
  getFocusedWindow: () => import("electron").BrowserWindow | null;
  /** OS notification constructor — for test injection. When omitted, Electron's Notification is loaded lazily via require. */
  electronNotificationCtor?: typeof import("electron").Notification;
  /**
   * broadcast function injection — for tests. When omitted, the ipc-router broadcast is used.
   */
  broadcastFn?: (channel: string, event: string, args: unknown) => void;
  /**
   * Workspace activation callback — called when a notification is clicked.
   */
  activateWorkspace?: (workspaceId: string) => Promise<void>;
  /** App window focus callback — called when a notification is clicked. */
  focusMainWindow?: () => void;
  /**
   * Getter for the OS notification master toggle — false when the user turned it off in Settings.
   * Evaluated on every call, so a toggle change takes effect at once. When omitted (default), always true.
   * Checked just before firing, so the in-app status broker (sidebar indicator) is unaffected.
   */
  notificationsEnabled?: () => boolean;
}

// ---------------------------------------------------------------------------
// Notification payload helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the message field from a Claude Code Notification hook payload.
 * Only the message field is trusted, per the spec (confirmed in T1).
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
 * Extracts the prompt from a Claude Code UserPromptSubmit hook payload.
 * A whole pasted file can arrive, so it is cut at PROMPT_MAX_CHARS (text the user typed is kept in full).
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
 * Extracts tool_name from a Claude Code PermissionRequest hook payload.
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
  "print-text",
  "print-end",
]);

/**
 * The hook a `claude -p` run holds open while it goes on: answered only to
 * stop the run, it is told gone once the run is over, as when it is killed
 * before it tells its end.
 */
const PRINT_WATCH = "print-watch";

/** How a run's watch is answered to stop the run: hookclient's printStopAnswer. */
export const PRINT_STOP_ANSWER = "stop";

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
// OS notification helpers
// ---------------------------------------------------------------------------

/**
 * Set that keeps strong references to fired Electron Notification objects.
 *
 * An Electron Notification is a main-process object; if its reference is dropped right after
 * show(), GC can collect it and the OS notification is dropped at once (notably on macOS).
 * Holding it in the Set until the close/click event fires prevents that.
 *
 * Usage: add right after creating the notification, delete on the close event.
 */
const pendingNotifications = new Set<import("electron").Notification>();

/**
 * Registers a Notification object in pendingNotifications and removes it automatically on close.
 * As a fail-safe for test fakes that never fire a close event, it also sets a
 * timeout that force-removes the entry after 5 minutes.
 */
function trackNotification(n: import("electron").Notification): void {
  pendingNotifications.add(n);
  const cleanup = () => {
    pendingNotifications.delete(n);
  };
  // close — when the OS dismisses the notification or the user closes it.
  // ts: Notification is an EventEmitter, so the `on` call signature is loose.
  (n as unknown as { on(event: string, cb: () => void): void }).on("close", cleanup);
  // When click fires, clean up together just before close (event order does not matter).
  (n as unknown as { on(event: string, cb: () => void): void }).on("click", cleanup);
  // Safety timeout — release the reference after 5 minutes even if neither event arrives.
  setTimeout(cleanup, 5 * 60 * 1000).unref?.();
}

/**
 * Fires an OS notification unconditionally. The caller must first check the condition
 * "the user is not looking at that tab" (isViewingThisTab === false) before calling.
 *
 * On click: focus the main window + activate the workspace + jump to that tab
 * (notificationClick broadcast — the legitimate use of an OS notification click).
 */
function fireOsNotification(
  workspaceId: string,
  tabId: string,
  title: string,
  body: string,
  deps: HookHandlerDeps,
): void {
  // User master toggle guard. The in-app status broker (glyph/card) was already handled by the
  // caller, so blocking only here leaves visual feedback such as sidebar attention intact.
  // Sidebar/tab indicators and OS notifications are deliberately controlled separately.
  if (deps.notificationsEnabled !== undefined && !deps.notificationsEnabled()) {
    return;
  }
  // The agent manager's session is shown in its dock, never as a tab, and
  // its answers and requests become notifications of their own, under their
  // own setting (features/manager): one of these, at every turn, would
  // also open a workspace the app keeps out of its lists.
  if (isManagerWorkspace(workspaceId)) return;

  const broadcastFn = deps.broadcastFn ?? broadcast;
  const NotificationCtor =
    deps.electronNotificationCtor ??
    (require("electron") as typeof import("electron")).Notification;

  showDesktopNotification(() => {
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
  });
}

// ---------------------------------------------------------------------------
// hook event handling
// ---------------------------------------------------------------------------

/**
 * Handles a single "claude.hook" event payload.
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
  // print-run), for the agent list only: the session's own state is its turn's.
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

  deps.activity?.noteHook(workspaceId, tabId, subcommand, hookPayload, parsed.data.agentMessages);

  // Common — whether the user is currently looking at this tab.
  // Every hook that may fire a notification (Notification/PermissionRequest/Stop) uses the same criterion.
  // With several workspaces and tabs, app focus alone is not enough.
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
      // Session start — Claude enters the waiting-for-input state. Real work begins at
      // user-prompt-submit, so SessionStart is not running. The broker entry is created but left
      // idle, so no glyph shows (the idle glyph is null) and the first prompt submit moves it
      // to running naturally.
      // It is a new session, so the previous session's prompt is cleared.
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
      // User prompt submitted — switch to running and reply at once (async hook).
      // (A notificationClick broadcast used to be sent here; it caused a yank-back bug and was removed.
      // The broker.set status change clears the attention indicator.)
      // The prompt is stored too, so the session view can show what the session is doing.
      // A new turn: the session's own dialogs are over, a subagent's may not be.
      dialogs.closeAgent(key, MAIN_AGENT);
      setState("running", undefined, extractPrompt(hookPayload));
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    case "pre-tool-use": {
      // Just before a tool runs — switch to running and reply at once (async hook).
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
      // Claude Code notification — switch to needsInput + message.
      // Fire an OS notification if the user is not looking at that tab.
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
      // If the user is looking at that tab, leave it idle as Stop does — they are already
      // looking, so there is no reason for a glyph or inbox entry (a needsInput that arose while
      // not looking is turned back to idle by markSeen once the tab is viewed).
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
      // Permission request — permissionPending, plus an OS notification if the user is not looking at that tab.
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

      // Held for an answer from the agent list while Claude Code shows its
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
      // Claude finished responding — branches:
      //  - User is looking at that tab: go straight to idle (already looking, so no notification or indicator is needed).
      //  - Otherwise: transition to completed + fire an OS notification. When the user activates
      //    the tab, the markSeen IPC moves it to idle.
      //
      // assistantText is the last assistant message (single line, at most 500 chars) that hookclient
      // read directly from transcript_path on the same host. It may be empty (no transcript, parse
      // failure, etc. — silent fallback); then the sidebar shows only the glyph.
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
        // An OS notification suits a short body — send the response preview if there is one,
        // otherwise static text. The sidebar card trims it again with its own cut (50 chars).
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
      // Told for the agent list only (deps.activity, above).
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
      // Session end — remove the entry and reply at once (async hook).
      turns.end(workspaceId, tabId);
      dialogs.clear(key);
      broker.clear(workspaceId, tabId);
      await respondHook(deps.channelProvider, workspaceId, hookId, { exitCode: 0 });
      break;
    }

    default:
      // Unknown subcommand — ignore (a Claude Code update may add new events).
      break;
  }

  // A request whose dialog closed was answered in the terminal, or is past.
  deps.asks?.retain(workspaceId, tabId, (asker, call) => dialogs.isOpenFor(key, asker, call));
}

/**
 * The user answered a held permission request from the agent list: its
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
 * A Claude tab's user answered the last permission request it showed. No
 * hook tells of it until the call allowed ends, which can be long: the
 * session's dialogs are closed now. Stopping the turn leaves the session
 * waiting on the user, as an interrupt does.
 */
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

/**
 * Calls the claude.respondHook dispatch method through the workspaceId's AgentChannel.
 * On failure it only logs a warning and moves on — leaving it to Claude Code's timeout fallback.
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
// Public wiring function
// ---------------------------------------------------------------------------

/**
 * Registers the "claude.hook" event subscription on agentHost.
 *
 * Called once from setupClaudeFeature.
 * The return value is the unsubscribe function.
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
  // interrupts at the dialog, which the terminal's own watch tells. A
  // `claude -p` run's watch ends with the run, told of or not.
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
