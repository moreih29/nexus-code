/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


export type HarnessObserverEvent = TabBadgeEvent | ToolCallEvent | SessionHistoryEvent;
export type TabBadgeState = "running" | "awaiting-approval" | "completed" | "error";
export type ToolCallStatus = "started" | "completed" | "awaiting-approval" | "error";

export interface TabBadgeEvent {
  type: "harness/tab-badge";
  state: TabBadgeState;
  sessionId: string;
  adapterName: string;
  workspaceId: WorkspaceId;
  timestamp: string;
}
export interface ToolCallEvent {
  type: "harness/tool-call";
  status: ToolCallStatus;
  toolName: string;
  sessionId: string;
  adapterName: string;
  workspaceId: WorkspaceId;
  timestamp: string;
  toolCallId?: string;
  inputSummary?: string;
  resultSummary?: string;
  message?: string;
}
export interface SessionHistoryEvent {
  type: "harness/session-history";
  sessionId: string;
  adapterName: string;
  workspaceId: WorkspaceId;
  timestamp: string;
  transcriptPath: string;
}
