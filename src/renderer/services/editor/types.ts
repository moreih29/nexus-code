export interface EditorInput {
  workspaceId: string;
  filePath: string;
  origin?: "workspace" | "external" | "untitled";
  readOnly?: boolean;
}

export type EditorTabProps = EditorInput;

export interface OpenEditorOptions {
  revealIfOpened?: boolean;
  preview?: boolean;
  newSplit?: {
    orientation: "horizontal" | "vertical";
    side: "before" | "after";
    isPreview?: boolean;
  };
}

export interface EditorTabLocation {
  groupId: string;
  tabId: string;
}
