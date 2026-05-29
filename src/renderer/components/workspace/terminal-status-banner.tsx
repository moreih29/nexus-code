import i18next from "i18next";
import { requestTerminalReopen } from "../../services/terminal/reopen-requests";
import type { Tab, TerminalTab } from "../../state/stores/tabs";
import type { TerminalDeathAggregate } from "../../state/stores/terminal-deaths";
import { Banner } from "../ui/banner";

interface WorkspaceTerminalStatusBannerProps {
  deadTerminalCount: number;
  onReopenAll: () => void;
}

interface WorkspaceTerminalBannerVisibilityInput {
  aggregate: TerminalDeathAggregate | null;
  deadTerminalCount: number;
  workspaceOnline: boolean;
}

/**
 * Returns the terminal tabs that currently need an explicit reopen.
 */
export function deadTerminalTabs(tabs: Record<string, Tab>): TerminalTab[] {
  return Object.values(tabs).filter(
    (tab): tab is Extract<Tab, { type: "terminal" }> =>
      tab.type === "terminal" && Boolean(tab.props.dead),
  );
}

/**
 * Chooses whether the workspace-level dead-terminal aggregate affordance should
 * be visible. Requires at least two concurrently-dead terminals within the same
 * aggregate window.
 *
 * When the workspace itself is offline, this banner is suppressed — the
 * workspace's own offline UI is responsible for recovery in that state, and
 * surfacing this banner alongside it would be redundant.
 */
export function shouldShowWorkspaceTerminalStatusBanner({
  aggregate,
  deadTerminalCount,
  workspaceOnline,
}: WorkspaceTerminalBannerVisibilityInput): boolean {
  if (deadTerminalCount === 0) return false;
  // Offline state is handled by the workspace's own offline component; this
  // banner must not compete with that affordance.
  if (!workspaceOnline) return false;
  return deadTerminalCount >= 2 && (aggregate?.tabIds.length ?? 0) >= 2;
}

/**
 * Builds the aggregate banner copy without inferring remote process state.
 */
export function workspaceTerminalStatusMessage(deadTerminalCount: number): string {
  return i18next.t("terminal.aggregate", { count: deadTerminalCount });
}

/**
 * Sends a manual reopen request to every dead terminal tab in the workspace.
 */
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

/**
 * Displays the workspace-level aggregate dead-terminal affordance.
 */
export function WorkspaceTerminalStatusBanner({
  deadTerminalCount,
  onReopenAll,
}: WorkspaceTerminalStatusBannerProps) {
  return (
    <Banner
      display="bar"
      variant="info"
      message={workspaceTerminalStatusMessage(deadTerminalCount)}
      actions={[{ label: i18next.t("action.reopenAll"), onAction: onReopenAll }]}
      role="status"
    />
  );
}
