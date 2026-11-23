import i18next from "i18next";
import { requestTerminalReopen } from "../../services/terminal/reopen-requests";
import type { Tab, TerminalTab } from "../../state/stores/tabs";
import type { TerminalDeathAggregate } from "../../state/stores/terminal-deaths";
import { Banner, type BannerDismiss } from "../ui/banner";

interface WorkspaceTerminalStatusBannerProps {
  dismiss?: BannerDismiss;
  deadTerminalCount: number;
  onReopenAll: () => void;
}

interface WorkspaceTerminalBannerVisibilityInput {
  aggregate: TerminalDeathAggregate | null;
  deadTerminalCount: number;
  workspaceOnline: boolean;
}

export function deadTerminalTabs(tabs: Record<string, Tab>): TerminalTab[] {
  return Object.values(tabs).filter(
    (tab): tab is Extract<Tab, { type: "terminal" }> =>
      tab.type === "terminal" && Boolean(tab.props.dead),
  );
}

export function shouldShowWorkspaceTerminalStatusBanner({
  aggregate,
  deadTerminalCount,
  workspaceOnline,
}: WorkspaceTerminalBannerVisibilityInput): boolean {
  if (deadTerminalCount === 0) return false;
  if (!workspaceOnline) return false;
  return deadTerminalCount >= 2 && (aggregate?.tabIds.length ?? 0) >= 2;
}

export function workspaceTerminalStatusMessage(deadTerminalCount: number): string {
  return i18next.t("terminal.aggregate", { count: deadTerminalCount });
}

export function requestReopenForDeadTerminalTabs(
  workspaceId: string,
  tabs: Record<string, Tab>,
): number {
  const targets = deadTerminalTabs(tabs);
  for (const tab of targets) {
    requestTerminalReopen(workspaceId, tab.id);
  }
  return targets.length;
}

export function WorkspaceTerminalStatusBanner({
  dismiss,
  deadTerminalCount,
  onReopenAll,
}: WorkspaceTerminalStatusBannerProps) {
  return (
    <Banner
      display="bar"
      dismiss={dismiss}
      variant="info"
      message={workspaceTerminalStatusMessage(deadTerminalCount)}
      actions={[{ label: i18next.t("action.reopenAll"), onAction: onReopenAll }]}
      role="status"
    />
  );
}
