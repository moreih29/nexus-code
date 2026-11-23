import { useCallback, useEffect, useRef, useState } from "react";
import { requestTabFocus } from "@/services/tab-focus";
import { moveTabToZone, openFileAtZone } from "@/state/operations";
import { type DropZone, MIME_FILE, MIME_TAB } from "../../../types/workbench-dnd";
import { hasSupportedMime, parseDragPayload } from "../../../utils/workbench-dnd-payload";
import { DND_FILE_SURFACE_SELECTOR, DND_TAB_BAR_SELECTOR } from "./markers";

const EDGE_THRESHOLD = 1 / 3;

export function zoneFromCoords(rect: DOMRect, clientX: number, clientY: number): DropZone {
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
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

function isInTabBar(target: EventTarget | null): boolean {
  return (target as HTMLElement | null)?.closest(DND_TAB_BAR_SELECTOR) != null;
}

function isOnFileSurface(e: DragEvent): boolean {
  const types = e.dataTransfer?.types ?? [];
  if (!types.includes(MIME_FILE) || types.includes(MIME_TAB)) return false;
  return (e.target as HTMLElement | null)?.closest?.(DND_FILE_SURFACE_SELECTOR) != null;
}

export interface UseDropTargetOptions {
  workspaceId: string;
  groupId: string;
}

export interface UseDropTargetResult {
  dropZone: DropZone | null;
  attachRef: (el: HTMLElement | null) => void;
  zoneRef: (el: HTMLElement | null) => void;
}

export function useDropTarget(opts: UseDropTargetOptions): UseDropTargetResult {
  const { workspaceId, groupId } = opts;
  const [dropZone, setDropZone] = useState<DropZone | null>(null);

  const [attachEl, setAttachEl] = useState<HTMLElement | null>(null);
  const attachRef = useCallback((el: HTMLElement | null) => setAttachEl(el), []);

  const zoneElRef = useRef<HTMLElement | null>(null);
  const zoneRef = useCallback((el: HTMLElement | null) => {
    zoneElRef.current = el;
  }, []);

  const enterCountRef = useRef(0);

  const reset = useCallback(() => {
    enterCountRef.current = 0;
    setDropZone(null);
  }, []);

  useEffect(() => {
    if (!attachEl) return;
    const element = attachEl;
    const getZoneRect = () => (zoneElRef.current ?? element).getBoundingClientRect();

    function onEnter(e: DragEvent) {
      if (!e.dataTransfer) return;
      if (!hasSupportedMime(e.dataTransfer.types)) return;
      if (isInTabBar(e.target)) {
        setDropZone((prev) => (prev === null ? prev : null));
        return;
      }
      e.stopPropagation();
      enterCountRef.current += 1;
      if (enterCountRef.current === 1 && !isOnFileSurface(e)) {
        const rect = getZoneRect();
        setDropZone(zoneFromCoords(rect, e.clientX, e.clientY));
      }
    }

    function onOver(e: DragEvent) {
      if (!e.dataTransfer) return;
      if (!hasSupportedMime(e.dataTransfer.types)) return;
      if (isInTabBar(e.target) || isOnFileSurface(e)) {
        setDropZone((prev) => (prev === null ? prev : null));
        return;
      }
      e.preventDefault();
      e.stopPropagation();
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
      if (isInTabBar(e.target)) return;
      if (isOnFileSurface(e)) {
        reset();
        return;
      }
      const parsed = parseDragPayload(e.dataTransfer);
      if (!parsed) return;

      e.preventDefault();
      e.stopPropagation();

      const rect = getZoneRect();
      const zone = zoneFromCoords(rect, e.clientX, e.clientY);

      try {
        if (parsed.kind === "tab") {
          const { workspaceId: srcWs, tabId } = parsed.payload;
          if (srcWs !== workspaceId) return;
          const moved = moveTabToZone(workspaceId, tabId, { groupId, zone });
          if (moved) requestTabFocus(moved.tabId);
        } else {
          const { workspaceId: srcWs, filePaths } = parsed.payload;
          if (srcWs !== workspaceId) return;
          openFileAtZone(workspaceId, filePaths[0], { groupId, zone });
        }
      } finally {
        reset();
      }
    }

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

  useEffect(() => {
    function onDocDragEnd() {
      reset();
    }
    document.addEventListener("dragend", onDocDragEnd);
    return () => document.removeEventListener("dragend", onDocDragEnd);
  }, [reset]);

  return { dropZone, attachRef, zoneRef };
}
