export const MIME_WORKSPACE_ROW = "application/x-nexus-workspace-row";

export interface WorkspaceRowDragPayload {
  workspaceId: string;
  pinned: boolean;
}

export function parseWorkspaceDragPayload(dt: DataTransfer): WorkspaceRowDragPayload | null {
  const raw = dt.getData(MIME_WORKSPACE_ROW);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).workspaceId !== "string" ||
      typeof (parsed as Record<string, unknown>).pinned !== "boolean"
    ) {
      return null;
    }
    return parsed as WorkspaceRowDragPayload;
  } catch {
    return null;
  }
}

export function hasWorkspaceRowMime(types: ReadonlyArray<string>): boolean {
  return types.includes(MIME_WORKSPACE_ROW);
}
