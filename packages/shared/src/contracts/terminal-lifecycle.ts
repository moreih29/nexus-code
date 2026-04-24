import type { TerminalTabId } from "./terminal-tab";
import type { WorkspaceId } from "./workspace";

export type TerminalCloseReason = "user-close" | "workspace-close" | "app-shutdown";

export type WorkspaceTerminalsClosedReason = Exclude<TerminalCloseReason, "user-close">;

export interface WorkspaceTerminalsClosedEvent {
  type: "terminal/workspace-terminals-closed";
  workspaceId: WorkspaceId;
  closedTabIds: TerminalTabId[];
  reason: WorkspaceTerminalsClosedReason;
}

export type TerminalLifecycleMessage = WorkspaceTerminalsClosedEvent;
