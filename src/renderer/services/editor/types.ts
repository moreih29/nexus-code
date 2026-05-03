// Public types for the editor service layer.
// EditorInput is the identity used across services to dedupe and locate tabs.

export interface EditorInput {
  workspaceId: string;
  filePath: string;
}

export interface OpenEditorOptions {
  /** When the input is already open in any group, focus that group. Defaults to true. */
  revealIfOpened?: boolean;
  /** Force open in a new split rather than reuse. */
  newSplit?: { orientation: "horizontal" | "vertical"; side: "before" | "after" };
}

export interface EditorTabLocation {
  groupId: string;
  tabId: string;
}
