import type { WorkspaceFileKind, WorkspaceGitBadgeStatus } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";

export const FILE_TREE_DRAG_MIME = "application/x-nexus-file-tree-node";
export const FILE_TREE_EXTERNAL_LARGE_FILE_THRESHOLD_BYTES = 100 * 1024 * 1024;

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

export function serializeFileTreeDragData(data: FileTreeDragData): string {
  return JSON.stringify(data);
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
