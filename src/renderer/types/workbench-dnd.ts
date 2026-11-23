export const MIME_TAB = "application/x-nexus-tab";
export const MIME_FILE = "application/x-nexus-file";

export interface TabDragPayload {
  workspaceId: string;
  tabId: string;
  sourceGroupId: string;
}

export interface FileDragPayload {
  workspaceId: string;
  filePaths: readonly string[];
}

export type DropZone = "top" | "right" | "bottom" | "left" | "center";
