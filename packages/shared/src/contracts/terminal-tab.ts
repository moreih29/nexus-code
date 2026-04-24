import type { WorkspaceId } from "./workspace";

export type TerminalTabId = `tt_${WorkspaceId}_${string}`;

export interface TerminalTabDescriptor {
  tabId: TerminalTabId;
  workspaceId: WorkspaceId;
}
