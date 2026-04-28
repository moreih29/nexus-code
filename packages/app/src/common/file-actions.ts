import type { WorkspaceFileKind } from "../../../shared/src/contracts/editor/editor-bridge";
import type { TerminalOpenedEvent } from "../../../shared/src/contracts/terminal/terminal-ipc";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";

export type FileClipboardOperation = "copy" | "cut";
export type FilePasteConflictStrategy = "prompt" | "replace" | "keep-both" | "skip";
export const FILE_EXTERNAL_DRAG_LARGE_FILE_THRESHOLD_BYTES = 100 * 1024 * 1024;

export interface FileClipboardEntry {
  workspaceId: WorkspaceId;
  path: string;
  kind: WorkspaceFileKind;
}

export interface FilePasteRequest {
  type: "file-actions/clipboard/paste";
  workspaceId: WorkspaceId;
  targetDirectory: string | null;
  operation: FileClipboardOperation;
  entries: FileClipboardEntry[];
  conflictStrategy?: FilePasteConflictStrategy;
}

export interface FilePasteCollision {
  sourcePath: string;
  targetPath: string;
  kind: WorkspaceFileKind;
}

export interface FilePasteAppliedEntry {
  sourceWorkspaceId: WorkspaceId;
  sourcePath: string;
  targetWorkspaceId: WorkspaceId;
  targetPath: string;
  kind: WorkspaceFileKind;
  operation: FileClipboardOperation;
}

export interface FilePasteSkippedEntry {
  sourcePath: string;
  targetPath: string;
  reason: "same-path" | "conflict";
}

export interface FilePasteResult {
  type: "file-actions/clipboard/paste/result";
  workspaceId: WorkspaceId;
  operation: FileClipboardOperation;
  applied: FilePasteAppliedEntry[];
  collisions: FilePasteCollision[];
  skipped: FilePasteSkippedEntry[];
}

export interface FileExternalDragInSource {
  absolutePath: string;
  name: string;
  size: number;
}

export interface FileExternalDragInRequest {
  type: "file-actions/external-drag-in";
  workspaceId: WorkspaceId;
  targetDirectory: string | null;
  files: FileExternalDragInSource[];
  conflictStrategy?: FilePasteConflictStrategy;
}

export interface FileExternalDragInAppliedEntry {
  sourcePath: string;
  targetPath: string;
  kind: WorkspaceFileKind;
  size: number;
}

export interface FileExternalDragInSkippedEntry {
  sourcePath: string;
  targetPath: string;
  reason: "same-path" | "conflict";
}

export interface FileExternalDragLargeFile {
  sourcePath: string;
  size: number;
}

export interface FileExternalDragInResult {
  type: "file-actions/external-drag-in/result";
  workspaceId: WorkspaceId;
  applied: FileExternalDragInAppliedEntry[];
  collisions: FilePasteCollision[];
  skipped: FileExternalDragInSkippedEntry[];
  largeFiles: FileExternalDragLargeFile[];
}

export type FileActionsShellAction =
  | "revealInFinder"
  | "openWithSystemApp"
  | "openInTerminal"
  | "copyPath"
  | "startFileDrag";

export interface FileActionPathRequest {
  workspaceId: WorkspaceId;
  path: string | null;
}

export interface FileActionRevealInFinderRequest extends FileActionPathRequest {
  type: "file-actions/reveal-in-finder";
}

export interface FileActionOpenWithSystemAppRequest extends FileActionPathRequest {
  type: "file-actions/open-with-system-app";
}

export interface FileActionOpenInTerminalRequest extends FileActionPathRequest {
  type: "file-actions/open-in-terminal";
  kind: WorkspaceFileKind | "workspace";
}

export interface FileActionCopyPathRequest extends FileActionPathRequest {
  type: "file-actions/copy-path";
  pathKind?: "absolute" | "relative";
}

export interface FileActionStartFileDragRequest {
  type: "file-actions/start-file-drag";
  workspaceId: WorkspaceId;
  paths: string[];
}

export type FileActionsRequest =
  | FileActionRevealInFinderRequest
  | FileActionOpenWithSystemAppRequest
  | FileActionOpenInTerminalRequest
  | FileActionCopyPathRequest
  | FileActionStartFileDragRequest
  | FilePasteRequest
  | FileExternalDragInRequest;

export interface FileActionsShellResult {
  type: "file-actions/shell/result";
  action: FileActionsShellAction;
  workspaceId: WorkspaceId;
  path: string | null;
  absolutePath: string;
  openedTerminal?: TerminalOpenedEvent;
}

export interface FileActionsCopyPathResult {
  type: "file-actions/copy-path/result";
  workspaceId: WorkspaceId;
  path: string | null;
  copiedText: string;
  pathKind: "absolute" | "relative";
}

export interface FileActionStartFileDragResult {
  type: "file-actions/start-file-drag/result";
  workspaceId: WorkspaceId;
  paths: string[];
  absolutePaths: string[];
}

export type FileActionsResult =
  | FileActionsShellResult
  | FileActionsCopyPathResult
  | FileActionStartFileDragResult
  | FilePasteResult
  | FileExternalDragInResult;
