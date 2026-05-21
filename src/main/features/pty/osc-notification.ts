// OSC escape sequence parser and Electron notification dispatcher.
// Supports OSC 9, OSC 777 (notify), and OSC 99 — the three variants that
// terminal tools may emit to request OS notifications.
//
// Claude Code 통합 알림 채널 재정의 (T7 결정):
// Claude Code 세션에서는 `preferredNotifChannel: "notifications_disabled"` 설정이
// 래퍼 scripts/assets/claude-wrapper.sh에 의해 주입되므로 Claude Code 자체는
// OSC 9/777/99 채널로 알림을 발사하지 않는다.
// Claude Code 알림은 hook 채널(internal/hookserver → "claude.hook" NDJSON 이벤트 →
// src/main/features/claude/hook-handler.ts)을 통해 처리된다.
//
// 이 파서는 Claude Code 이외의 일반 PTY 알림 전용 채널로 의미가 재정의된다:
//   - 사용자가 직접 실행하는 shell 스크립트의 OSC 알림
//   - Claude 이외의 CLI 도구(aider, 기타 AI agent CLI 등)가 보내는 알림
//   - NEXUS_IN_APP=0 경로(래퍼 passthrough) — Claude Code가 원래 동작으로 OSC 발사
// OSC 채널 비활성화 시에도 이 파서를 제거하지 않는 이유는 위와 같다.

import { broadcast } from "../../infra/ipc-router";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OscNotification {
  kind: "osc9" | "osc99" | "osc777";
  title?: string;
  body: string;
}

// Dependency shape injected into OscNotificationDispatcher — narrow interface
// so callers (and tests) don't need to pass a full WorkspaceManager.
export interface WorkspaceNameLookup {
  getName(id: string): string | null;
}

export interface OscNotificationDispatcherDeps {
  workspaceManager: WorkspaceNameLookup;
  getFocusedWindow: () => import("electron").BrowserWindow | null;
  /** Called on notification click to activate the workspace in main. */
  activateWorkspace?: (workspaceId: string) => Promise<void>;
  /** Called on notification click to bring the app window to the foreground. */
  focusMainWindow?: () => void;
  /** Injected in tests to avoid real Electron Notification. */
  electronNotificationCtor?: typeof import("electron").Notification;
  /**
   * Injected in tests to intercept broadcast calls. Defaults to the real
   * `broadcast` from ipc-router when omitted.
   */
  broadcastFn?: (channel: string, event: string, args: unknown) => void;
}

// ---------------------------------------------------------------------------
// Pure parser
// ---------------------------------------------------------------------------

// OSC 9:   ESC ] 9 ; <body> BEL|ST
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC escape sequences require ESC and BEL literals
const OSC9_RE = /\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// OSC 777: ESC ] 777 ; notify ; <title> ; <body> BEL|ST
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC escape sequences require ESC and BEL literals
const OSC777_RE = /\x1b\]777;notify;([^;]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// OSC 99:  ESC ] 99 ; <params> ; <body> BEL|ST
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC escape sequences require ESC and BEL literals
const OSC99_RE = /\x1b\]99;([^;]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

// Extracts optional `p=title:VALUE` from OSC 99 params field.
const OSC99_TITLE_PARAM_RE = /(?:^|;)p=title:([^;]*)/;

/**
 * Parses `chunk` for OSC 9/777/99 escape sequences and returns a list of
 * notification descriptors. Pure function — no side effects, no mutation.
 */
export function extractOscNotifications(chunk: string): OscNotification[] {
  const results: OscNotification[] = [];

  for (const m of chunk.matchAll(OSC9_RE)) {
    results.push({ kind: "osc9", body: m[1] });
  }

  for (const m of chunk.matchAll(OSC777_RE)) {
    results.push({ kind: "osc777", title: m[1], body: m[2] });
  }

  for (const m of chunk.matchAll(OSC99_RE)) {
    const params = m[1];
    const body = m[2];
    const titleMatch = OSC99_TITLE_PARAM_RE.exec(params);
    results.push({
      kind: "osc99",
      ...(titleMatch ? { title: titleMatch[1] } : {}),
      body,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Listens to PTY data chunks, extracts OSC notifications, and either fires an
 * OS-level Electron Notification (window unfocused) or broadcasts an in-app
 * event (window focused).
 */
export class OscNotificationDispatcher {
  private readonly deps: OscNotificationDispatcherDeps;

  constructor(deps: OscNotificationDispatcherDeps) {
    this.deps = deps;
  }

  /**
   * Process a raw PTY data chunk. Must be called with the original, unmodified
   * chunk — this method never mutates it.
   */
  handleChunk(workspaceId: string, tabId: string, chunk: string): void {
    const notifications = extractOscNotifications(chunk);
    if (notifications.length === 0) return;

    const { workspaceManager, getFocusedWindow } = this.deps;

    // Resolve workspace name once per chunk since all notifications share it.
    const workspaceName = workspaceManager.getName(workspaceId) ?? "Terminal";

    const focusedWindow = getFocusedWindow();
    const isAppFocused = focusedWindow !== null && !focusedWindow.isMinimized();

    const broadcastFn = this.deps.broadcastFn ?? broadcast;

    for (const notification of notifications) {
      if (isAppFocused) {
        // App is in the foreground — skip the OS notification but still
        // broadcast so the renderer can show an in-app indicator if desired.
        broadcastFn("pty", "notificationClick", { workspaceId, tabId });
        continue;
      }

      this.fireOsNotification(workspaceId, tabId, workspaceName, notification, broadcastFn);
    }
  }

  private fireOsNotification(
    workspaceId: string,
    tabId: string,
    workspaceName: string,
    notification: OscNotification,
    broadcastFn: (channel: string, event: string, args: unknown) => void,
  ): void {
    // Prefer the injected ctor (tests), fall back to the real Electron one.
    // Lazy require keeps test environments working when electron is partially mocked.
    const NotificationCtor =
      this.deps.electronNotificationCtor ??
      (require("electron") as typeof import("electron")).Notification;

    const title = notification.title
      ? `[${workspaceName}] ${notification.title}`
      : `[${workspaceName}]`;

    const n = new NotificationCtor({ title, body: notification.body });

    n.on("click", () => {
      // 1. Bring the app window to the foreground.
      this.deps.focusMainWindow?.();

      // 2. Activate the workspace in main (fire-and-forget).
      this.deps.activateWorkspace?.(workspaceId)?.catch((err) => {
        console.warn("[osc-notification] activateWorkspace failed:", err);
      });

      // 3. Tell the renderer to reveal the workspace + tab.
      broadcastFn("pty", "notificationClick", { workspaceId, tabId });
    });

    n.show();
  }
}
