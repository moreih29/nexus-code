/**
 * Drop-target hook for a layout leaf.
 *
 * Owns: dragenter / dragleave / dragover / drop wiring on the group's slot
 *       element, the visible flag (counter-based to avoid flicker on child
 *       transitions), zone calculation from cursor coordinates, and dispatch
 *       to operations.ts.
 *
 * Caller owns: attaching the returned `ref` to the slot element and
 *              rendering the indicator using `dropZone` (null when not
 *              hovered).
 *
 * IMPORTANT: native DOM addEventListener is used here, not React synthetic
 * events. React's createPortal dispatches child events to React-tree
 * ancestors of the portal-host (ContentPool), not DOM-tree ancestors. So
 * children of the slot — Monaco editor, xterm.js — that are mounted via
 * createPortal would be invisible to React onDrop / onDropCapture handlers
 * on the slot. Native DOM bubble follows the DOM tree and reaches us
 * regardless. Capture phase additionally lets us intercept before children
 * stopPropagation in their bubble handlers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { moveTabToZone, openFileAtZone } from "@/state/operations";
import {
  type DropZone,
  type FileDragPayload,
  MIME_FILE,
  MIME_TAB,
  type TabDragPayload,
} from "./types";

const EDGE_THRESHOLD = 1 / 3;

/**
 * VSCode-style 5-zone classification.
 *
 * - Cursor outside the zone rect (e.g. over the tab-bar above the content
 *   area) → center, so dragging to the tab-bar drops into the group.
 * - Otherwise: distance from each edge in [0, 1]; closest edge within 1/3
 *   wins, beyond that → center.
 */
function zoneFromCoords(rect: DOMRect, clientX: number, clientY: number): DropZone {
  if (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return "center";
  }

  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;

  const distances: Array<[DropZone, number]> = [
    ["top", relY],
    ["bottom", 1 - relY],
    ["left", relX],
    ["right", 1 - relX],
  ];

  let minZone: DropZone = "center";
  let minDist = Number.POSITIVE_INFINITY;
  for (const [zone, dist] of distances) {
    if (dist < minDist) {
      minZone = zone;
      minDist = dist;
    }
  }
  if (minDist > EDGE_THRESHOLD) return "center";
  return minZone;
}

function readPayload(
  dt: DataTransfer,
): { kind: "tab"; payload: TabDragPayload } | { kind: "file"; payload: FileDragPayload } | null {
  const tabRaw = dt.getData(MIME_TAB);
  if (tabRaw) {
    try {
      return { kind: "tab", payload: JSON.parse(tabRaw) as TabDragPayload };
    } catch {
      return null;
    }
  }
  const fileRaw = dt.getData(MIME_FILE);
  if (fileRaw) {
    try {
      return { kind: "file", payload: JSON.parse(fileRaw) as FileDragPayload };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The MIME types we recognise. dataTransfer.types is exposed during dragenter
 * and dragover (but not the data itself for cross-window security), so we can
 * decide whether to even show the indicator before drop.
 */
function hasSupportedMime(types: ReadonlyArray<string>): boolean {
  return types.includes(MIME_TAB) || types.includes(MIME_FILE);
}

/**
 * Test whether the event target is inside the tab bar that owns its own
 * dropTarget (single "|" insertion-line indicator with precise index).
 * When true, the group-level handler defers — it doesn't stopPropagation,
 * so the capture phase continues to the tab bar's listeners.
 */
const TAB_BAR_DATA_ATTR = "data-dnd-tab-bar";

function isInTabBar(target: EventTarget | null): boolean {
  return (target as HTMLElement | null)?.closest(`[${TAB_BAR_DATA_ATTR}]`) != null;
}

export interface UseDropTargetOptions {
  workspaceId: string;
  groupId: string;
}

export interface UseDropTargetResult {
  dropZone: DropZone | null;
  /**
   * Callback ref for the listener-attachment element. Use the **outer**
   * wrapper that covers all surfaces you want to receive drops (tab-bar +
   * content slot) so the cursor anywhere inside the group lands on us.
   */
  attachRef: (el: HTMLElement | null) => void;
  /**
   * Callback ref for the zone-measurement element — the content slot.
   * Cursor positions outside this rect are classified as `center` (so the
   * tab-bar drops "into the group" without showing edge indicators).
   * If never set, the attach element is used as a fallback.
   */
  zoneRef: (el: HTMLElement | null) => void;
}

export function useDropTarget(opts: UseDropTargetOptions): UseDropTargetResult {
  const { workspaceId, groupId } = opts;
  const [dropZone, setDropZone] = useState<DropZone | null>(null);

  // The listener-attachment element. Tracked as state so the effect re-runs
  // when the ref changes (mutable refs do not trigger effects).
  const [attachEl, setAttachEl] = useState<HTMLElement | null>(null);
  const attachRef = useCallback((el: HTMLElement | null) => setAttachEl(el), []);

  // The zone-measurement element (content slot). Cursor outside this rect
  // → center. Falls back to the attach element when not set.
  const zoneElRef = useRef<HTMLElement | null>(null);
  const zoneRef = useCallback((el: HTMLElement | null) => {
    zoneElRef.current = el;
  }, []);

  // Counter survives bubbling from descendants — every dragenter on a
  // descendant fires once on us (capture phase), balanced by a dragleave when
  // the cursor exits that descendant. Only when the counter returns to 0 has
  // the cursor truly left the slot.
  const enterCountRef = useRef(0);

  const reset = useCallback(() => {
    enterCountRef.current = 0;
    setDropZone(null);
  }, []);

  useEffect(() => {
    if (!attachEl) return;
    const element = attachEl;
    const getZoneRect = () =>
      (zoneElRef.current ?? element).getBoundingClientRect();

    function onEnter(e: DragEvent) {
      if (!e.dataTransfer) return;
      if (!hasSupportedMime(e.dataTransfer.types)) return;
      // Defer to TabItem's own dropTarget when cursor is on a tab — the tab
      // item handles precise-index insertion. Don't stopPropagation; let the
      // capture phase continue to the tab item.
      if (isInTabBar(e.target)) {
        // Tab bar handles its own indicator; clear ours if any was set.
        setDropZone((prev) => (prev === null ? prev : null));
        return;
      }
      // Capture phase — we are running before any child sees the event.
      // stopPropagation prevents Monaco/xterm from interpreting our drag.
      e.stopPropagation();
      enterCountRef.current += 1;
      if (enterCountRef.current === 1) {
        const rect = getZoneRect();
        setDropZone(zoneFromCoords(rect, e.clientX, e.clientY));
      }
    }

    function onOver(e: DragEvent) {
      if (!e.dataTransfer) return;
      if (!hasSupportedMime(e.dataTransfer.types)) return;
      if (isInTabBar(e.target)) {
        setDropZone((prev) => (prev === null ? prev : null));
        return;
      }
      // preventDefault is required to allow drop; stopPropagation prevents
      // children from also calling preventDefault with a different
      // dropEffect that disagrees with effectAllowed.
      e.preventDefault();
      e.stopPropagation();
      // dropEffect MUST be compatible with the source's effectAllowed,
      // otherwise the browser forces dropEffect to "none" and the drop
      // event never fires. File source uses "copy" (we create a new tab),
      // tab source uses "move" (the tab itself relocates).
      const isFile = e.dataTransfer.types.includes(MIME_FILE);
      e.dataTransfer.dropEffect = isFile ? "copy" : "move";
      const rect = getZoneRect();
      const next = zoneFromCoords(rect, e.clientX, e.clientY);
      setDropZone((prev) => (prev === next ? prev : next));
    }

    function onLeave(e: DragEvent) {
      if (!e.dataTransfer) return;
      if (!hasSupportedMime(e.dataTransfer.types)) return;
      if (isInTabBar(e.target)) return;
      e.stopPropagation();
      enterCountRef.current = Math.max(0, enterCountRef.current - 1);
      if (enterCountRef.current === 0) {
        reset();
      }
    }

    function onDrop(e: DragEvent) {
      if (!e.dataTransfer) return;
      // Tab item handled it — exit before consuming the event.
      if (isInTabBar(e.target)) return;
      const parsed = readPayload(e.dataTransfer);
      if (!parsed) return;

      e.preventDefault();
      e.stopPropagation();

      const rect = getZoneRect();
      const zone = zoneFromCoords(rect, e.clientX, e.clientY);

      try {
        if (parsed.kind === "tab") {
          const { workspaceId: srcWs, tabId } = parsed.payload;
          if (srcWs !== workspaceId) return;
          moveTabToZone(workspaceId, tabId, { groupId, zone });
        } else {
          const { workspaceId: srcWs, filePath } = parsed.payload;
          if (srcWs !== workspaceId) return;
          openFileAtZone(workspaceId, filePath, { groupId, zone });
        }
      } finally {
        reset();
      }
    }

    // Capture phase across the board so we run before any child handlers.
    element.addEventListener("dragenter", onEnter, true);
    element.addEventListener("dragover", onOver, true);
    element.addEventListener("dragleave", onLeave, true);
    element.addEventListener("drop", onDrop, true);

    return () => {
      element.removeEventListener("dragenter", onEnter, true);
      element.removeEventListener("dragover", onOver, true);
      element.removeEventListener("dragleave", onLeave, true);
      element.removeEventListener("drop", onDrop, true);
    };
  }, [attachEl, workspaceId, groupId, reset]);

  // Belt-and-suspenders: dragend on the document fires even when drop happens
  // outside the app, in another window, or on a non-droppable target.
  useEffect(() => {
    function onDocDragEnd() {
      reset();
    }
    document.addEventListener("dragend", onDocDragEnd);
    return () => document.removeEventListener("dragend", onDocDragEnd);
  }, [reset]);

  return { dropZone, attachRef, zoneRef };
}
