// Public types for the editor service layer.
// EditorInput is the identity used across services to dedupe and locate tabs.

export interface EditorInput {
  workspaceId: string;
  filePath: string;
  /** Defaults to "workspace". External files (T4/T5) set "external". */
  origin?: "workspace" | "external";
  /** Defaults to false. When true the editor and save-service enforce read-only. */
  readOnly?: boolean;
}

export type EditorTabProps = EditorInput;

export interface OpenEditorOptions {
  /** When the input is already open in any group, focus that group. Defaults to true. */
  revealIfOpened?: boolean;
  /**
   * When true (default), the file enters as a preview tab — single-click
   * semantics from the file tree, reusable preview slot, italicized title.
   * When false, callers ask for a permanent (non-preview) tab from the
   * start; mirrors VSCode's `pinned: true` opt-out used by file-tree
   * double-click and similar "I really want this kept" gestures.
   */
  preview?: boolean;
  /** Force open in a new split rather than reuse. */
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
