import { createLogger } from "../../../shared/log/main";
import { redactLogSecrets } from "../../../shared/log/redact-secrets";

const log = createLogger("cli-notify");

export interface NotifierDeps {
  isViewing(workspaceId: string, tabId: string): boolean;
  notificationsEnabled(): boolean;
  workspaceName(workspaceId: string): string | null;
  reveal(workspaceId: string, tabId: string): void;
  notificationCtor?: typeof import("electron").Notification;
}

const live = new Set<unknown>();

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
      log.warn(
        `revealing the tab failed: ${redactLogSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }
  });
  n.on("close", release);
  live.add(n);
  setTimeout(release, 5 * 60 * 1000).unref?.();
  n.show();
  return true;
}
