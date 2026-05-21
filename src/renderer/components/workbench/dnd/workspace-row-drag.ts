/**
 * Drag payload type and MIME constant for workspace sidebar row dragging.
 *
 * The dataTransfer object is the only channel between dragstart and drop;
 * it must round-trip through JSON, so payload fields must be plain
 * serializable values only.
 *
 * Kept separate from workspace/dnd/types.ts — that module belongs to the
 * panel-layout / tab DnD system and uses a different drop model.
 */

// ---------------------------------------------------------------------------
// MIME type
// ---------------------------------------------------------------------------

/**
 * MIME type written into dataTransfer when a workspace sidebar row is dragged.
 * Distinct from MIME_TAB / MIME_FILE so workspace-row drops are never
 * mis-classified as tab or file operations.
 */
export const MIME_WORKSPACE_ROW = "application/x-nexus-workspace-row";

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** Data serialised into dataTransfer at dragstart for a workspace row. */
export interface WorkspaceRowDragPayload {
  /** ID of the workspace being dragged. */
  workspaceId: string;
  /** Pinned state at drag-start; used to detect cross-group moves. */
  pinned: boolean;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Extracts and validates the workspace-row payload from a DataTransfer.
 *
 * Returns `null` if the MIME slot is absent, empty, or contains invalid JSON
 * — callers treat null as "not a workspace-row drag" and ignore the event.
 */
export function parseWorkspaceDragPayload(
  dt: DataTransfer,
): WorkspaceRowDragPayload | null {
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

// ---------------------------------------------------------------------------
// MIME guard
// ---------------------------------------------------------------------------

/**
 * Returns true when the dataTransfer types array contains the workspace-row
 * MIME. Used in dragenter/dragover handlers to decide whether to accept the
 * drag before the payload data is accessible (cross-window security).
 */
export function hasWorkspaceRowMime(types: ReadonlyArray<string>): boolean {
  return types.includes(MIME_WORKSPACE_ROW);
}
