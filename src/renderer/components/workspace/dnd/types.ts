/**
 * Drag-and-drop payload types and MIME constants for workspace D&D.
 *
 * The dataTransfer object is the only channel between dragstart and drop, and
 * it must round-trip through JSON — payloads must contain plain serializable
 * fields only. Group ids and similar references are *hints*; the drop side
 * must re-resolve them against the live store.
 */
export const MIME_TAB = "application/x-nexus-tab";
export const MIME_FILE = "application/x-nexus-file";

/** Payload written to dataTransfer when a tab is the drag source. */
export interface TabDragPayload {
  workspaceId: string;
  tabId: string;
  /** Hint only — re-query the store at drop time to find the real owner. */
  sourceGroupId: string;
}

/** Payload written to dataTransfer when a file-tree row is the drag source. */
export interface FileDragPayload {
  workspaceId: string;
  filePath: string;
}

/**
 * Hover zone within a drop target group.
 *
 * `top` / `right` / `bottom` / `left` request a new split in that direction.
 * `center` requests a tab move into the target group itself (or reorder within
 * it).
 */
export type DropZone = "top" | "right" | "bottom" | "left" | "center";
