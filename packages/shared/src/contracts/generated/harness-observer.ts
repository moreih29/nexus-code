/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


export type HarnessObserverEvent = TabBadgeEvent;
export type TabBadgeState = "running" | "awaiting-approval" | "completed" | "error";

export interface TabBadgeEvent {
  type: "harness/tab-badge";
  state: TabBadgeState;
  sessionId: string;
  adapterName: string;
  workspaceId: WorkspaceId;
  timestamp: string;
}
