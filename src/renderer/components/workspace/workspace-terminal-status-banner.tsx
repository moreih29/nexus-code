import { requestTerminalReopen } from "../../services/terminal/reopen-requests";
import type { Tab, TerminalTab } from "../../state/stores/tabs";
import type { TerminalDeathAggregate } from "../../state/stores/terminal-deaths";

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
 * Chooses whether the workspace-level dead-terminal affordance should be
 * visible for aggregate deaths or for an offline workspace hiding per-tab
 * banners.
 */
export function shouldShowWorkspaceTerminalStatusBanner({
  aggregate,
  deadTerminalCount,
  workspaceOnline,
}: WorkspaceTerminalBannerVisibilityInput): boolean {
  if (deadTerminalCount === 0) return false;
  if (!workspaceOnline) return true;
  return deadTerminalCount >= 2 && (aggregate?.tabIds.length ?? 0) >= 2;
}

/**
 * Builds the aggregate banner copy without inferring remote process state.
 */
export function workspaceTerminalStatusMessage(deadTerminalCount: number): string {
  const terminalLabel = deadTerminalCount === 1 ? "terminal" : "terminals";
  return `${deadTerminalCount} ${terminalLabel} ended.`;
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
    <div
      role="status"
      className="flex items-center justify-between shrink-0 h-6 px-3 bg-frosted-veil border-b border-mist-border text-app-ui-xs app-status-banner-text"
    >
      <span>{workspaceTerminalStatusMessage(deadTerminalCount)}</span>
      <button
        type="button"
        className="text-app-ui-xs app-status-banner-text hover:opacity-80 cursor-pointer bg-transparent border-0 p-0"
        onClick={onReopenAll}
      >
        Reopen all
      </button>
    </div>
  );
}
