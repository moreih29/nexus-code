import { createLogger } from "../../../shared/log/main";
import { tryGetMainT } from "../../i18n";
import { broadcast } from "../../infra/ipc-router";
import { showDesktopNotification } from "../../infra/platform/desktop-notifications";

export interface OscNotification {
  kind: "osc9" | "osc99" | "osc777";
  title?: string;
  body: string;
}

const log = createLogger("osc-notification");

export interface WorkspaceNameLookup {
  getName(id: string): string | null;
}

export interface OscNotificationDispatcherDeps {
  workspaceManager: WorkspaceNameLookup;
  getFocusedWindow: () => import("electron").BrowserWindow | null;
  isActiveTab?: (workspaceId: string, tabId: string) => boolean;
  notificationsEnabled?: () => boolean;
  connectWorkspace?: (workspaceId: string) => Promise<void>;
  focusMainWindow?: () => void;
  electronNotificationCtor?: typeof import("electron").Notification;
  broadcastFn?: (channel: string, event: string, args: unknown) => void;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC escape sequences require ESC and BEL literals
const OSC9_RE = /\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC escape sequences require ESC and BEL literals
const OSC777_RE = /\x1b\]777;notify;([^;]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC escape sequences require ESC and BEL literals
const OSC99_RE = /\x1b\]99;([^;]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

const OSC99_TITLE_PARAM_RE = /(?:^|;)p=title:([^;]*)/;

export function extractOscNotifications(chunk: string): OscNotification[] {
  const results: OscNotification[] = [];

  if (!chunk.includes("\x1b]")) return results;

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

export class OscNotificationDispatcher {
  private readonly deps: OscNotificationDispatcherDeps;

  constructor(deps: OscNotificationDispatcherDeps) {
    this.deps = deps;
  }

  handleChunk(workspaceId: string, tabId: string, chunk: string): void {
    const notifications = extractOscNotifications(chunk);
    if (notifications.length === 0) return;

    const { workspaceManager, getFocusedWindow, isActiveTab, notificationsEnabled } = this.deps;
    if (notificationsEnabled?.() === false) return;

    const focusedWindow = getFocusedWindow();
    const isAppFocused = focusedWindow !== null && !focusedWindow.isMinimized();
    if (isAppFocused && (isActiveTab?.(workspaceId, tabId) ?? true)) return;

    const _t = tryGetMainT();
    const workspaceName =
      workspaceManager.getName(workspaceId) ??
      (_t ? _t("common:claudeNotification.terminalFallback") : "Terminal");

    const broadcastFn = this.deps.broadcastFn ?? broadcast;

    for (const notification of notifications) {
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
    const NotificationCtor =
      this.deps.electronNotificationCtor ??
      (require("electron") as typeof import("electron")).Notification;

    const title = notification.title
      ? `[${workspaceName}] ${notification.title}`
      : `[${workspaceName}]`;

    showDesktopNotification(() => {
      const n = new NotificationCtor({ title, body: notification.body });

      n.on("click", () => {
        this.deps.focusMainWindow?.();

        this.deps.connectWorkspace?.(workspaceId)?.catch((err) => {
          log.warn(`connectWorkspace failed: ${(err as Error).message}`);
        });

        broadcastFn("pty", "notificationClick", { workspaceId, tabId });
      });

      n.show();
    });
  }
}
