/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


export type WorkspaceSessionAction =
  | WorkspaceOpenAction
  | WorkspaceActivateAction
  | WorkspaceCloseAction;
export type WorkspaceOpenSource = "folder-picker" | "session-restore";
export type WorkspaceActivateSource = "click" | "keyboard" | "session-restore";
export type WorkspaceCloseSource = "user-close" | "app-shutdown";

export interface WorkspaceOpenAction {
  type: "workspace/open";
  workspaceId: WorkspaceId;
  /**
   * NFC-normalized absolute filesystem path
   */
  absolutePath: string;
  displayName: string;
  source: WorkspaceOpenSource;
}
export interface WorkspaceActivateAction {
  type: "workspace/activate";
  workspaceId: WorkspaceId;
  source: WorkspaceActivateSource;
}
export interface WorkspaceCloseAction {
  type: "workspace/close";
  workspaceId: WorkspaceId;
  source: WorkspaceCloseSource;
}
