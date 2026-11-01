/**
 * The desktop notification `nexus notify` raises, on the terms Claude's
 * hook notifications follow: not while the user looks at the terminal, not
 * when notifications are off, and a click brings the user to the terminal.
 */
import { createLogger } from "../../../shared/log/main";

const log = createLogger("cli-notify");

export interface NotifierDeps {
  /** Whether the user is looking at the tab: the app has focus and shows it. */
  isViewing(workspaceId: string, tabId: string): boolean;
  notificationsEnabled(): boolean;
  workspaceName(workspaceId: string): string | null;
  /** Brings the app forward and shows the tab. */
  reveal(workspaceId: string, tabId: string): void;
  /** Tests pass a fake. */
  notificationCtor?: typeof import("electron").Notification;
}

// A notification nothing references can be collected before it is clicked.
const live = new Set<unknown>();

/** Shows the notification; false when it is not to be shown. */
export function notifyTab(
  deps: NotifierDeps,
  workspaceId: string,
  tabId: string,
  title: string,
  body: string,
): boolean {
  if (!deps.notificationsEnabled() || deps.isViewing(workspaceId, tabId)) return false;
  const Ctor =
    deps.notificationCtor ?? (require("electron") as typeof import("electron")).Notification;
  const name = deps.workspaceName(workspaceId);
  const heading = [name ? `[${name}]` : "", title].filter(Boolean).join(" ") || "NexusCode";
  const n = new Ctor({ title: heading, body });
  const release = () => live.delete(n);
  n.on("click", () => {
    release();
    try {
      deps.reveal(workspaceId, tabId);
    } catch (error) {
      log.warn(`revealing the tab failed: ${(error as Error).message}`);
    }
  });
  n.on("close", release);
  live.add(n);
  setTimeout(release, 5 * 60 * 1000).unref?.();
  n.show();
  return true;
}
