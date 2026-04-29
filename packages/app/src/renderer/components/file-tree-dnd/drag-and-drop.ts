import type { WorkspaceFileKind, WorkspaceGitBadgeStatus } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { TerminalTabId } from "../../../../../shared/src/contracts/terminal/terminal-tab";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import type {
  ExternalEditorDropPayload,
  ExternalEditorWorkspaceFileDropItem,
} from "../../services/editor-types";

export const FILE_TREE_DRAG_MIME = "application/x-nexus-file-tree-node";
export const NEXUS_TAB_DRAG_MIME = "application/x-nexus-tab";
export const FILE_TREE_EXTERNAL_LARGE_FILE_THRESHOLD_BYTES = 100 * 1024 * 1024;

export type TerminalTabDragData = Extract<ExternalEditorDropPayload, { type: "terminal-tab" }>;

export interface ReadExternalEditorDropPayloadOptions {
  resolveExternalFilePath?: (file: File) => string | null | undefined;
}

export type FileTreeDropPosition = "insert-above" | "over" | "insert-below";
export type FileTreeDropIndicatorState = "over" | "insert" | "invalid";
export type FileTreeDropInvalidReason =
  | "self"
  | "child"
  | "git-ignored"
  | "different-workspace"
  | "multi-drag";

export interface FileTreeDragData {
  workspaceId: WorkspaceId;
  path: string;
  kind: WorkspaceFileKind;
}

export interface FileTreeDropValidationNode {
  path: string;
  kind: WorkspaceFileKind;
  gitStatus?: WorkspaceGitBadgeStatus | null;
}

export interface FileTreeDropValidationInput {
  sourceWorkspaceId: WorkspaceId;
  targetWorkspaceId: WorkspaceId;
  draggedNodes: readonly FileTreeDropValidationNode[];
  targetParentPath: string | null;
  targetGitStatus?: WorkspaceGitBadgeStatus | null;
}

export interface FileTreeDropValidationResult {
  valid: boolean;
  reason: FileTreeDropInvalidReason | null;
}

export interface FileTreeMoveDestinationInput {
  draggedPath: string;
  targetParentPath: string | null;
}

export interface FileTreeDropTargetNode {
  path: string;
  kind: WorkspaceFileKind;
  parentPath: string | null;
  gitStatus?: WorkspaceGitBadgeStatus | null;
}

export interface FileTreeDropTargetResolution {
  targetDirectory: string | null;
  indicatorState: FileTreeDropIndicatorState;
}

export function dropPositionFromClientY({
  clientY,
  rowTop,
  rowHeight,
}: {
  clientY: number;
  rowTop: number;
  rowHeight: number;
}): FileTreeDropPosition {
  if (rowHeight <= 0) {
    return "over";
  }

  const relativeY = Math.min(Math.max(clientY - rowTop, 0), rowHeight);
  const ratio = relativeY / rowHeight;
  if (ratio < 0.25) {
    return "insert-above";
  }
  if (ratio >= 0.75) {
    return "insert-below";
  }
  return "over";
}

export function indicatorStateForDropPosition(position: FileTreeDropPosition): FileTreeDropIndicatorState {
  return position === "over" ? "over" : "insert";
}

export function resolveDropTargetDirectory(
  target: FileTreeDropTargetNode | null,
  position: FileTreeDropPosition,
): FileTreeDropTargetResolution {
  if (!target) {
    return {
      targetDirectory: null,
      indicatorState: "over",
    };
  }

  if (position === "over") {
    if (target.kind !== "directory") {
      return {
        targetDirectory: target.parentPath,
        indicatorState: "invalid",
      };
    }

    return {
      targetDirectory: target.path,
      indicatorState: "over",
    };
  }

  return {
    targetDirectory: target.parentPath,
    indicatorState: "insert",
  };
}

export function validateFileTreeDrop({
  sourceWorkspaceId,
  targetWorkspaceId,
  draggedNodes,
  targetParentPath,
  targetGitStatus = null,
}: FileTreeDropValidationInput): FileTreeDropValidationResult {
  if (sourceWorkspaceId !== targetWorkspaceId) {
    return invalidDrop("different-workspace");
  }

  if (draggedNodes.length !== 1) {
    return invalidDrop("multi-drag");
  }

  const draggedNode = draggedNodes[0]!;
  if (isGitIgnored(draggedNode.gitStatus) || isGitIgnored(targetGitStatus)) {
    return invalidDrop("git-ignored");
  }

  if (targetParentPath === draggedNode.path) {
    return invalidDrop("self");
  }

  if (
    draggedNode.kind === "directory" &&
    targetParentPath !== null &&
    isDescendantPath(targetParentPath, draggedNode.path)
  ) {
    return invalidDrop("child");
  }

  return { valid: true, reason: null };
}

export function resolveFileTreeMoveDestinationPath({
  draggedPath,
  targetParentPath,
}: FileTreeMoveDestinationInput): string {
  const basename = basenameForWorkspacePath(draggedPath);
  return targetParentPath ? `${targetParentPath}/${basename}` : basename;
}

export function isGitIgnored(status: WorkspaceGitBadgeStatus | null | undefined): boolean {
  return status === "ignored";
}

export function isDescendantPath(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}

export function writeFileTreeDragDataTransfer(
  dataTransfer: Pick<DataTransfer, "setData" | "effectAllowed">,
  data: FileTreeDragData,
): void {
  const serialized = serializeFileTreeDragData(data);
  dataTransfer.setData(FILE_TREE_DRAG_MIME, serialized);
  dataTransfer.setData("text/plain", data.path);
  dataTransfer.effectAllowed = "copyMove";
}

export function readFileTreeDragDataTransfer(
  dataTransfer: Pick<DataTransfer, "getData" | "types"> | null | undefined,
): FileTreeDragData | null {
  if (!dataTransfer || !dataTransferHasType(dataTransfer, FILE_TREE_DRAG_MIME)) {
    return null;
  }

  return parseFileTreeDragData(dataTransfer.getData(FILE_TREE_DRAG_MIME));
}

export function writeTerminalTabDragDataTransfer(
  dataTransfer: Pick<DataTransfer, "setData" | "effectAllowed">,
  data: TerminalTabDragData,
): void {
  dataTransfer.setData(NEXUS_TAB_DRAG_MIME, serializeTerminalTabDragData(data));
  dataTransfer.setData("text/plain", data.tabId);
  dataTransfer.effectAllowed = "move";
}

export function readTerminalTabDragDataTransfer(
  dataTransfer: Pick<DataTransfer, "getData" | "types"> | null | undefined,
): TerminalTabDragData | null {
  if (!dataTransfer || !dataTransferHasType(dataTransfer, NEXUS_TAB_DRAG_MIME)) {
    return null;
  }

  return parseTerminalTabDropPayload(dataTransfer.getData(NEXUS_TAB_DRAG_MIME));
}

export function dataTransferHasTerminalTabDragData(
  dataTransfer: Pick<DataTransfer, "types"> | null | undefined,
): boolean {
  return dataTransferHasType(dataTransfer, NEXUS_TAB_DRAG_MIME);
}

export function readExternalEditorDropPayload(
  dataTransfer: Pick<DataTransfer, "getData" | "types"> & Partial<Pick<DataTransfer, "files">> | null | undefined,
  options: ReadExternalEditorDropPayloadOptions = {},
): ExternalEditorDropPayload | null {
  if (!dataTransfer) {
    return null;
  }

  if (dataTransferHasType(dataTransfer, FILE_TREE_DRAG_MIME)) {
    return parseWorkspaceFileDropPayload(dataTransfer.getData(FILE_TREE_DRAG_MIME));
  }

  if (dataTransferHasType(dataTransfer, NEXUS_TAB_DRAG_MIME)) {
    return parseTerminalTabDropPayload(dataTransfer.getData(NEXUS_TAB_DRAG_MIME));
  }

  if (dataTransferHasExternalFiles(dataTransfer)) {
    const files = Array.from(dataTransfer.files ?? []);
    const resolvedPaths = files.map((file) => resolveExternalEditorFilePath(file, options.resolveExternalFilePath));
    return files.length > 0
      ? {
          type: "os-file",
          files,
          ...(resolvedPaths.some((filePath) => filePath.length > 0) ? { resolvedPaths } : {}),
        }
      : null;
  }

  return null;
}

export function serializeFileTreeDragData(data: FileTreeDragData): string {
  return JSON.stringify(data);
}

export function serializeTerminalTabDragData(data: TerminalTabDragData): string {
  return JSON.stringify({
    type: "terminal-tab",
    workspaceId: data.workspaceId,
    tabId: data.tabId,
    ...(data.source ? { source: data.source } : {}),
    ...(data.sourceGroupId ? { sourceGroupId: data.sourceGroupId } : {}),
  });
}

export function parseFileTreeDragData(rawValue: string): FileTreeDragData | null {
  try {
    const value = JSON.parse(rawValue) as Partial<FileTreeDragData>;
    if (
      typeof value.workspaceId === "string" &&
      typeof value.path === "string" &&
      (value.kind === "file" || value.kind === "directory")
    ) {
      return {
        workspaceId: value.workspaceId as WorkspaceId,
        path: value.path,
        kind: value.kind,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function parseWorkspaceFileDropPayload(rawValue: string): Extract<
  ExternalEditorDropPayload,
  { type: "workspace-file" | "workspace-file-multi" }
> | null {
  const singleFile = parseFileTreeDragData(rawValue);
  if (singleFile) {
    return {
      type: "workspace-file",
      workspaceId: singleFile.workspaceId,
      path: singleFile.path,
      kind: singleFile.kind,
    };
  }

  const multiFile = parseFileTreeMultiDragData(rawValue);
  if (!multiFile) {
    return null;
  }

  return {
    type: "workspace-file-multi",
    workspaceId: multiFile.workspaceId,
    items: multiFile.items,
  };
}

function parseFileTreeMultiDragData(rawValue: string): {
  workspaceId: WorkspaceId;
  items: ExternalEditorWorkspaceFileDropItem[];
} | null {
  try {
    const value = JSON.parse(rawValue);
    if (!isRecord(value) || typeof value.workspaceId !== "string" || !Array.isArray(value.items)) {
      return null;
    }

    const items = value.items
      .map((item) => parseWorkspaceFileDropItem(item))
      .filter((item): item is ExternalEditorWorkspaceFileDropItem => item !== null);
    if (items.length !== value.items.length || items.length < 2) {
      return null;
    }

    return {
      workspaceId: value.workspaceId as WorkspaceId,
      items,
    };
  } catch {
    return null;
  }
}

function parseWorkspaceFileDropItem(value: unknown): ExternalEditorWorkspaceFileDropItem | null {
  if (
    isRecord(value) &&
    typeof value.path === "string" &&
    (value.kind === "file" || value.kind === "directory")
  ) {
    return {
      path: value.path,
      kind: value.kind,
    };
  }

  return null;
}

function parseTerminalTabDropPayload(rawValue: string): Extract<
  ExternalEditorDropPayload,
  { type: "terminal-tab" }
> | null {
  try {
    const value = JSON.parse(rawValue);
    if (!isRecord(value) || !isTerminalTabDropRecord(value)) {
      return null;
    }

    const tabId = typeof value.tabId === "string"
      ? value.tabId
      : typeof value.id === "string"
        ? value.id
        : null;
    if (typeof value.workspaceId !== "string" || !tabId) {
      return null;
    }

    const source = value.source === "bottom-panel" || value.source === "editor-group"
      ? value.source
      : undefined;
    const sourceGroupId = typeof value.sourceGroupId === "string" && value.sourceGroupId.length > 0
      ? value.sourceGroupId
      : null;

    return {
      type: "terminal-tab",
      workspaceId: value.workspaceId as WorkspaceId,
      tabId: tabId as TerminalTabId,
      ...(source ? { source } : {}),
      ...(sourceGroupId ? { sourceGroupId } : {}),
    };
  } catch {
    return null;
  }
}

function isTerminalTabDropRecord(value: Record<string, unknown>): boolean {
  return value.type === "terminal-tab" || value.kind === "terminal" || value.tabKind === "terminal";
}

function resolveExternalEditorFilePath(
  file: File,
  resolveExternalFilePath?: (file: File) => string | null | undefined,
): string {
  try {
    const resolvedPath = resolveExternalFilePath?.(file);
    if (typeof resolvedPath === "string" && resolvedPath.length > 0) {
      return resolvedPath;
    }
  } catch {
    // Fall back to Electron's legacy File.path shape when the preload helper is unavailable.
  }

  const electronPath = (file as File & { path?: unknown }).path;
  return typeof electronPath === "string" ? electronPath : "";
}

export function dataTransferHasExternalFiles(
  dataTransfer: Pick<DataTransfer, "types"> | null | undefined,
): boolean {
  return dataTransferHasType(dataTransfer, "Files");
}

export function isLargeExternalFile(size: number | null | undefined): boolean {
  return typeof size === "number" && size > FILE_TREE_EXTERNAL_LARGE_FILE_THRESHOLD_BYTES;
}

function invalidDrop(reason: FileTreeDropInvalidReason): FileTreeDropValidationResult {
  return { valid: false, reason };
}

function basenameForWorkspacePath(workspacePath: string): string {
  return workspacePath.split("/").filter(Boolean).at(-1) ?? workspacePath;
}

function dataTransferHasType(
  dataTransfer: Pick<DataTransfer, "types"> | null | undefined,
  type: string,
): boolean {
  if (!dataTransfer) {
    return false;
  }

  return Array.from(dataTransfer.types ?? []).includes(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
