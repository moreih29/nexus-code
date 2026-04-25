/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { TerminalTabId, WorkspaceId } from "../_brands";


export type TerminalLifecycleMessage = WorkspaceTerminalsClosedEvent;
export type WorkspaceTerminalsClosedReason = "workspace-close" | "app-shutdown";

export interface WorkspaceTerminalsClosedEvent {
  type: "terminal/workspace-terminals-closed";
  workspaceId: WorkspaceId;
  closedTabIds: TerminalTabId[];
  reason: WorkspaceTerminalsClosedReason;
}
