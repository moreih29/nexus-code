/**
 * useWorkspaceRowDnd — HTML5 native drag-and-drop hook for workspace sidebar
 * rows, built on an explicit drop-slot model.
 *
 * DESIGN
 * ------
 * For N workspaces in a group, the sidebar renders N+1 drop slots: one above
 * each row and one below the last row. Adjacent slots between two rows are
 * shared (a single physical slot owns the gap between row K and row K+1).
 * This eliminates the ambiguity of the half-row model, where each physical
 * gap had two indicator placements ("after row K" and "before row K+1") and
 * only one of them actually moved the source.
 *
 * Hook responsibilities are split between:
 *   - getRowDragSourceProps(rowId, pinned)  — drag SOURCE only (dragstart/end)
 *   - getSlotDropProps(slot)                — drop TARGET only (dragover/drop)
 *
 * NO-OP SUPPRESSION
 * -----------------
 * When the source row is one of a slot's neighbours within the same group,
 * dropping there would leave the source in its current spot. Such slots are
 * suppressed (no indicator, no drop) so what the user sees maps 1:1 to what
 * will move. Cross-group drops are never classified as no-ops because they
 * flip the `pinned` flag.
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

/**
 * Describes one drop slot. `beforeId` is the row immediately below the slot
 * (undefined when the slot is at the very bottom of its group); `afterId` is
 * the row immediately above the slot (undefined when the slot is at the very
 * top of its group). When both are set, the slot lives between two rows.
 */
export interface SlotInfo {
  /** Stable React key + identity used by the hook to track the active slot. */
  key: string;
  /** Section the slot belongs to; drives the pinned flag on drop. */
  group: "pinned" | "unpinned";
  /** Row immediately below this slot (undefined → slot is at group bottom). */
  beforeId?: string;
  /** Row immediately above this slot (undefined → slot is at group top). */
  afterId?: string;
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
   * Workspaces in current display order. Used to detect no-op slots
   * (those adjacent to the source row within the same group).
   */
  workspaces: WorkspaceMeta[];
  /** Called once per successful drop with the resolved reorder parameters. */
  onReorder: (args: ReorderArgs) => void;
}

export interface UseWorkspaceRowDndResult {
  /** ID of the row currently being dragged, or null when not dragging. */
  dragSourceId: string | null;
  /** Key of the slot currently being hovered, or null. */
  activeSlotKey: string | null;
  /**
   * Returns drag-source props (dragstart/dragend) to spread on a row.
   * Rows DO NOT receive dragover/drop — those live on slots.
   */
  getRowDragSourceProps: (rowId: string, pinned: boolean) => {
    draggable: true;
    onDragStart: (e: React.DragEvent<HTMLElement>) => void;
    onDragEnd: (e: React.DragEvent<HTMLElement>) => void;
  };
  /** Returns drop-target props (dragover/drop) to spread on a slot. */
  getSlotDropProps: (slot: SlotInfo) => {
    onDragEnter: (e: React.DragEvent<HTMLElement>) => void;
    onDragOver: (e: React.DragEvent<HTMLElement>) => void;
    onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
    onDrop: (e: React.DragEvent<HTMLElement>) => void;
  };
  /**
   * Returns true when `slot` is suppressed for the current source — used by
   * the renderer to skip the visual indicator / hit area. When no drag is
   * in progress this returns false so slots stay neutral.
   */
  isSlotSuppressed: (slot: SlotInfo) => boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Builds the ordered list of drop slots for one workspace group. For N rows
 * the result has N+1 slots: one above each row plus one below the last row.
 * An empty group yields no slots — pinning an unpinned workspace into an
 * empty pinned group is done via the context menu, not drag.
 */
export function buildSlotsForGroup(
  group: WorkspaceMeta[],
  groupKind: "pinned" | "unpinned",
): SlotInfo[] {
  if (group.length === 0) return [];

  const slots: SlotInfo[] = [];

  // Top slot — above the first row.
  slots.push({
    key: `${groupKind}:top:${group[0].id}`,
    group: groupKind,
    beforeId: group[0].id,
  });

  // Between slots — one per adjacent row pair.
  for (let i = 0; i < group.length - 1; i += 1) {
    slots.push({
      key: `${groupKind}:between:${group[i].id}:${group[i + 1].id}`,
      group: groupKind,
      beforeId: group[i + 1].id,
      afterId: group[i].id,
    });
  }

  // Bottom slot — below the last row.
  slots.push({
    key: `${groupKind}:bottom:${group[group.length - 1].id}`,
    group: groupKind,
    afterId: group[group.length - 1].id,
  });

  return slots;
}

/**
 * A slot is no-op for the given source when dropping there would leave the
 * source at its current position. This is true exactly when both the source
 * and the slot live in the same group and the slot is one of the source's
 * direct neighbours (above or below). Cross-group slots always represent a
 * pin-flag flip, so they are never no-ops.
 */
export function isSlotNoOp(args: {
  source: WorkspaceMeta;
  slot: SlotInfo;
}): boolean {
  const { source, slot } = args;
  const sourceGroup: "pinned" | "unpinned" = source.pinned ? "pinned" : "unpinned";

  // Cross-group drop always changes state (pinned flip) — never a no-op.
  if (sourceGroup !== slot.group) return false;

  // The slot directly above the source row: dropping there keeps source in place.
  if (slot.beforeId === source.id) return true;
  // The slot directly below the source row: same — keeps source in place.
  if (slot.afterId === source.id) return true;
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
  const [activeSlotKey, setActiveSlotKey] = useState<string | null>(null);

  // Stable refs so handlers don't have to be recreated on each prop change.
  const onReorderRef = useRef(onReorder);
  useEffect(() => {
    onReorderRef.current = onReorder;
  });

  const workspacesRef = useRef(workspaces);
  useEffect(() => {
    workspacesRef.current = workspaces;
  });

  const sourcePayloadRef = useRef<WorkspaceRowDragPayload | null>(null);

  // Belt-and-suspenders: clean up if drag is cancelled or dropped outside.
  useEffect(() => {
    function onDocDragEnd() {
      setDragSourceId(null);
      setActiveSlotKey(null);
      sourcePayloadRef.current = null;
    }
    document.addEventListener("dragend", onDocDragEnd);
    return () => document.removeEventListener("dragend", onDocDragEnd);
  }, []);

  /**
   * Resolves the source row from refs and returns the slot's no-op status
   * for that source. Returns false if no drag is in progress.
   */
  const slotIsSuppressedForCurrentSource = useCallback((slot: SlotInfo): boolean => {
    const payload = sourcePayloadRef.current;
    if (!payload) return false;
    const source = workspacesRef.current.find((w) => w.id === payload.workspaceId);
    if (!source) return false;
    return isSlotNoOp({ source, slot });
  }, []);

  const getRowDragSourceProps = useCallback(
    (rowId: string, pinned: boolean) => {
      function onDragStart(e: React.DragEvent<HTMLElement>) {
        if (!e.dataTransfer) return;

        const payload: WorkspaceRowDragPayload = { workspaceId: rowId, pinned };

        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(MIME_WORKSPACE_ROW, JSON.stringify(payload));

        // Use the row element itself as the drag ghost so the cursor stays
        // anchored to the row content the user is moving.
        e.dataTransfer.setDragImage(e.currentTarget, 0, 0);

        sourcePayloadRef.current = payload;
        setDragSourceId(rowId);
      }

      function onDragEnd(_e: React.DragEvent<HTMLElement>) {
        setDragSourceId(null);
        setActiveSlotKey(null);
        sourcePayloadRef.current = null;
      }

      return {
        draggable: true as const,
        onDragStart,
        onDragEnd,
      };
    },
    [],
  );

  const getSlotDropProps = useCallback(
    (slot: SlotInfo) => {
      function onDragEnter(e: React.DragEvent<HTMLElement>) {
        if (!e.dataTransfer) return;
        if (!hasWorkspaceRowMime(e.dataTransfer.types)) return;
        if (slotIsSuppressedForCurrentSource(slot)) return;
        e.preventDefault();
      }

      function onDragOver(e: React.DragEvent<HTMLElement>) {
        if (!e.dataTransfer) return;
        if (!hasWorkspaceRowMime(e.dataTransfer.types)) return;

        // Suppressed slots don't preventDefault → browser will refuse the
        // drop and indicator stays hidden.
        if (slotIsSuppressedForCurrentSource(slot)) {
          if (activeSlotKey === slot.key) setActiveSlotKey(null);
          return;
        }

        e.preventDefault();
        e.dataTransfer.dropEffect = "move";

        if (activeSlotKey !== slot.key) setActiveSlotKey(slot.key);
      }

      function onDragLeave(_e: React.DragEvent<HTMLElement>) {
        // Only clear the active slot if it's the one being left; this avoids
        // flicker when the cursor moves between sibling overlay elements
        // that all belong to the same slot.
        if (activeSlotKey === slot.key) setActiveSlotKey(null);
      }

      function onDrop(e: React.DragEvent<HTMLElement>) {
        if (!e.dataTransfer) return;
        const payload = parseWorkspaceDragPayload(e.dataTransfer);
        if (!payload) return;

        e.preventDefault();
        e.stopPropagation();

        if (slotIsSuppressedForCurrentSource(slot)) {
          setActiveSlotKey(null);
          return;
        }

        const args: ReorderArgs = {
          id: payload.workspaceId,
          targetGroup: slot.group,
          ...(slot.beforeId ? { beforeId: slot.beforeId } : {}),
          ...(!slot.beforeId && slot.afterId ? { afterId: slot.afterId } : {}),
        };

        onReorderRef.current(args);
        setActiveSlotKey(null);
      }

      return { onDragEnter, onDragOver, onDragLeave, onDrop };
    },
    [activeSlotKey, slotIsSuppressedForCurrentSource],
  );

  return {
    dragSourceId,
    activeSlotKey,
    getRowDragSourceProps,
    getSlotDropProps,
    isSlotSuppressed: slotIsSuppressedForCurrentSource,
  };
}
