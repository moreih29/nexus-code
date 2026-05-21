/**
 * useWorkspaceRowDnd — HTML5 native drag-and-drop hook for workspace sidebar rows.
 *
 * DESIGN
 * ------
 * Each sidebar row is made draggable via the native HTML5 drag API
 * (draggable={true} on the container div). This delegates mouse-distance
 * detection and click/drag discrimination entirely to the browser — the
 * browser only fires dragstart after the user moves the pointer a few pixels,
 * so click handlers are never suppressed accidentally.
 *
 * Terminology:
 *   - Source row    — the row the user started dragging.
 *   - Target row    — the row currently under the cursor during dragover.
 *   - Drop position — "before" (cursor in top half of row) or "after" (bottom).
 *   - Target group  — "pinned" or "unpinned", derived from which section the
 *                     cursor is in during dragover / at drop time.
 *
 * CROSS-SECTION REORDER
 * ---------------------
 * When the cursor enters a row that belongs to a different section than the
 * source, targetGroup is set accordingly. The caller's onReorder receives the
 * resolved targetGroup so the IPC handler can flip the pinned flag atomically.
 *
 * NO-OP DROP
 * ----------
 * Dropping the source row immediately before or after itself (i.e. no real
 * position change) calls onReorder with no beforeId/afterId so that the IPC
 * handler places it at tail of its current group — which is effectively a
 * no-op from the user's perspective. A stricter same-neighbour check would
 * add complexity for little benefit; the server handles idempotent reorders.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import {
  hasWorkspaceRowMime,
  MIME_WORKSPACE_ROW,
  parseWorkspaceDragPayload,
  type WorkspaceRowDragPayload,
} from "./workspace-row-drag";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Identifies where the cursor is hovering during a drag. */
export interface DropTarget {
  /** ID of the row the cursor is currently over. */
  rowId: string;
  /** Whether the indicator should appear above ("before") or below ("after"). */
  position: "before" | "after";
  /** Which section the drop will land in; drives pin-toggle on cross-group drop. */
  targetGroup: "pinned" | "unpinned";
}

/** Arguments forwarded to the caller when a drop is committed. */
export interface ReorderArgs {
  id: string;
  beforeId?: string;
  afterId?: string;
  targetGroup: "pinned" | "unpinned";
}

export interface UseWorkspaceRowDndOptions {
  /**
   * The workspaces list currently rendered, in display order (pinned group
   * first, then unpinned). Used to detect no-op drops (drop position equals
   * the source's current position) so the indicator can be suppressed.
   */
  workspaces: WorkspaceMeta[];
  /** Called once per successful drop with the resolved reorder parameters. */
  onReorder: (args: ReorderArgs) => void;
}

export interface UseWorkspaceRowDndResult {
  /** ID of the row currently being dragged, or null when not dragging. */
  dragSourceId: string | null;
  /** Current drop target position, or null when not over a valid target. */
  dropTarget: DropTarget | null;
  /**
   * Returns drag-event props to spread onto a draggable row container div.
   *
   * @param rowId    — ID of the workspace this row represents.
   * @param pinned   — Current pinned state of the workspace.
   * @param rowGroup — Which section the row lives in ("pinned" | "unpinned").
   */
  getRowDragProps: (
    rowId: string,
    pinned: boolean,
    rowGroup: "pinned" | "unpinned",
  ) => {
    draggable: true;
    onDragStart: (e: React.DragEvent<HTMLElement>) => void;
    onDragEnd: (e: React.DragEvent<HTMLElement>) => void;
    onDragOver: (e: React.DragEvent<HTMLElement>) => void;
    onDrop: (e: React.DragEvent<HTMLElement>) => void;
    onDragEnter: (e: React.DragEvent<HTMLElement>) => void;
  };
}

// ---------------------------------------------------------------------------
// Pure helper — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Determines the drop position ("before" or "after") based on the cursor's
 * Y coordinate relative to the target row's bounding rectangle.
 *
 * The row is divided into equal halves: cursor in the top half → "before"
 * (insert above the target), cursor in the bottom half → "after" (insert
 * below the target).
 */
export function dropPositionFromCoords(
  rect: DOMRect,
  clientY: number,
): "before" | "after" {
  const midY = rect.top + rect.height / 2;
  return clientY < midY ? "before" : "after";
}

/**
 * Detects "ghost" drop positions that would leave the source row exactly
 * where it already is.
 *
 * Two adjacent rows share a single physical gap, but the half-row model
 * produces two indicator placements for it: "after row N" (bottom half of N)
 * and "before row N+1" (top half of N+1). When the source row is one of
 * these neighbors, one of the two placements is a no-op — visible to the
 * user but committing the drop does nothing. Hiding the no-op indicator
 * gives a strict 1:1 mapping between what the user sees and what will move.
 *
 * Cross-group drops are NEVER treated as no-ops because they always carry
 * the side effect of flipping the `pinned` flag.
 */
export function isNoOpDropPosition(args: {
  workspaces: WorkspaceMeta[];
  sourceId: string;
  targetId: string;
  position: "before" | "after";
  targetGroup: "pinned" | "unpinned";
}): boolean {
  const { workspaces, sourceId, targetId, position, targetGroup } = args;
  const source = workspaces.find((w) => w.id === sourceId);
  if (!source) return false;

  // Cross-group drops always change the pinned flag — never a no-op.
  const sourceGroup: "pinned" | "unpinned" = source.pinned ? "pinned" : "unpinned";
  if (sourceGroup !== targetGroup) return false;

  // Filter to the source's group to compute adjacency, since the rendered
  // list interleaves pinned and unpinned but adjacency is per-group.
  const group = workspaces.filter((w) =>
    targetGroup === "pinned" ? w.pinned : !w.pinned,
  );
  const sourceIdx = group.findIndex((w) => w.id === sourceId);
  const targetIdx = group.findIndex((w) => w.id === targetId);
  if (sourceIdx === -1 || targetIdx === -1) return false;

  // "before target" at the row directly after source → source stays put.
  if (position === "before" && targetIdx === sourceIdx + 1) return true;
  // "after target" at the row directly before source → source stays put.
  if (position === "after" && targetIdx === sourceIdx - 1) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWorkspaceRowDnd({
  workspaces,
  onReorder,
}: UseWorkspaceRowDndOptions): UseWorkspaceRowDndResult {
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // Keep a stable ref to onReorder so event handlers capture it without
  // needing to be recreated every time the callback identity changes.
  const onReorderRef = useRef(onReorder);
  useEffect(() => {
    onReorderRef.current = onReorder;
  });

  // Latest workspaces snapshot in a ref so dragover can run no-op detection
  // without rebuilding event handlers on every list change.
  const workspacesRef = useRef(workspaces);
  useEffect(() => {
    workspacesRef.current = workspaces;
  });

  // Track current source payload in a ref so dragover / drop handlers can
  // read it without closing over stale state.
  const sourcePayloadRef = useRef<WorkspaceRowDragPayload | null>(null);

  // Belt-and-suspenders: reset drag state if the user drops outside the
  // sidebar or the drag is cancelled by the OS.
  useEffect(() => {
    function onDocDragEnd() {
      setDragSourceId(null);
      setDropTarget(null);
      sourcePayloadRef.current = null;
    }
    document.addEventListener("dragend", onDocDragEnd);
    return () => document.removeEventListener("dragend", onDocDragEnd);
  }, []);

  const getRowDragProps = useCallback(
    (rowId: string, pinned: boolean, rowGroup: "pinned" | "unpinned") => {
      function onDragStart(e: React.DragEvent<HTMLElement>) {
        if (!e.dataTransfer) return;

        const payload: WorkspaceRowDragPayload = {
          workspaceId: rowId,
          pinned,
        };

        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(MIME_WORKSPACE_ROW, JSON.stringify(payload));

        // Use the element itself as drag image anchored at top-left to leave
        // room for the drop-indicator on the target row.
        e.dataTransfer.setDragImage(e.currentTarget, 0, 0);

        sourcePayloadRef.current = payload;
        setDragSourceId(rowId);
      }

      function onDragEnd(_e: React.DragEvent<HTMLElement>) {
        // State reset on dragend — fires whether the drop was accepted or not.
        setDragSourceId(null);
        setDropTarget(null);
        sourcePayloadRef.current = null;
      }

      function onDragEnter(e: React.DragEvent<HTMLElement>) {
        if (!e.dataTransfer) return;
        if (!hasWorkspaceRowMime(e.dataTransfer.types)) return;
        // Accept the drag so dragover fires.
        e.preventDefault();
      }

      function onDragOver(e: React.DragEvent<HTMLElement>) {
        if (!e.dataTransfer) return;
        if (!hasWorkspaceRowMime(e.dataTransfer.types)) return;

        // Required to allow drop on this element.
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";

        const rect = e.currentTarget.getBoundingClientRect();
        const position = dropPositionFromCoords(rect, e.clientY);

        // Suppress the indicator when the drop would leave the source in
        // its current spot. Without this filter the user sees two indicator
        // positions for one physical gap (after row N vs before row N+1)
        // and only one of them produces a real movement.
        const sourcePayload = sourcePayloadRef.current;
        if (sourcePayload) {
          const noOp = isNoOpDropPosition({
            workspaces: workspacesRef.current,
            sourceId: sourcePayload.workspaceId,
            targetId: rowId,
            position,
            targetGroup: rowGroup,
          });
          if (noOp) {
            setDropTarget(null);
            return;
          }
        }

        setDropTarget((prev) => {
          if (prev?.rowId === rowId && prev.position === position && prev.targetGroup === rowGroup) {
            return prev; // no change — avoid spurious re-render
          }
          return { rowId, position, targetGroup: rowGroup };
        });
      }

      function onDrop(e: React.DragEvent<HTMLElement>) {
        if (!e.dataTransfer) return;
        const payload = parseWorkspaceDragPayload(e.dataTransfer);
        if (!payload) return;

        e.preventDefault();
        e.stopPropagation();

        const sourceId = payload.workspaceId;

        // Skip if dropped onto itself.
        if (sourceId === rowId) {
          setDropTarget(null);
          return;
        }

        const rect = e.currentTarget.getBoundingClientRect();
        const position = dropPositionFromCoords(rect, e.clientY);

        // Mirror onDragOver's no-op filter so a drop that snuck through
        // (e.g. before the dragover state caught up) still doesn't fire a
        // useless IPC round-trip.
        const noOp = isNoOpDropPosition({
          workspaces: workspacesRef.current,
          sourceId,
          targetId: rowId,
          position,
          targetGroup: rowGroup,
        });
        if (noOp) {
          setDropTarget(null);
          return;
        }

        const args: ReorderArgs = {
          id: sourceId,
          targetGroup: rowGroup,
          ...(position === "before" ? { beforeId: rowId } : { afterId: rowId }),
        };

        onReorderRef.current(args);
        setDropTarget(null);
      }

      return {
        draggable: true as const,
        onDragStart,
        onDragEnd,
        onDragEnter,
        onDragOver,
        onDrop,
      };
    },
    [], // stable — all mutable values read via refs
  );

  return { dragSourceId, dropTarget, getRowDragProps };
}
