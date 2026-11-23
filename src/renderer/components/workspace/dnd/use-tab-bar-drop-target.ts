import { useCallback, useEffect, useState } from "react";
import { requestTabFocus } from "@/services/tab-focus";
import { moveTabToZone, openFileAtZone } from "@/state/operations";
import { MIME_FILE } from "../../../types/workbench-dnd";
import { hasSupportedMime, parseDragPayload } from "../../../utils/workbench-dnd-payload";
import { DND_TAB_ITEM_SELECTOR } from "./markers";

export interface InsertionState {
  x: number;
  index: number;
}

export interface UseTabBarDropTargetOptions {
  workspaceId: string;
  leafId: string;
}

export interface UseTabBarDropTargetResult {
  barRef: (el: HTMLDivElement | null) => void;
  tabsListRef: (el: HTMLDivElement | null) => void;
  insertion: InsertionState | null;
}

export function useTabBarDropTarget(opts: UseTabBarDropTargetOptions): UseTabBarDropTargetResult {
  const { workspaceId, leafId } = opts;

  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const barRef = useCallback((el: HTMLDivElement | null) => setBar(el), []);
  const tabsListRef = useCallback((el: HTMLDivElement | null) => setList(el), []);
  const [insertion, setInsertion] = useState<InsertionState | null>(null);

  useEffect(() => {
    if (!bar || !list) return;
    const barEl = bar;
    const listEl = list;

    function getInsertion(clientX: number): InsertionState {
      const items = Array.from(listEl.querySelectorAll<HTMLElement>(DND_TAB_ITEM_SELECTOR));
      const listRect = listEl.getBoundingClientRect();

      if (items.length === 0) {
        return { x: 0, index: 0 };
      }

      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        const center = r.left + r.width / 2;
        if (clientX < center) {
          return { x: r.left - listRect.left, index: i };
        }
      }
      const lastRect = items[items.length - 1].getBoundingClientRect();
      return { x: lastRect.right - listRect.left, index: items.length };
    }

    function onEnter(e: DragEvent) {
      if (!e.dataTransfer || !hasSupportedMime(e.dataTransfer.types)) return;
      e.stopPropagation();
      setInsertion(getInsertion(e.clientX));
    }

    function onOver(e: DragEvent) {
      if (!e.dataTransfer || !hasSupportedMime(e.dataTransfer.types)) return;
      e.preventDefault();
      e.stopPropagation();
      const isFile = e.dataTransfer.types.includes(MIME_FILE);
      e.dataTransfer.dropEffect = isFile ? "copy" : "move";
      const next = getInsertion(e.clientX);
      setInsertion((prev) =>
        prev && prev.x === next.x && prev.index === next.index ? prev : next,
      );
    }

    function onLeave(e: DragEvent) {
      if (!e.dataTransfer || !hasSupportedMime(e.dataTransfer.types)) return;
      e.stopPropagation();
      const related = e.relatedTarget as Node | null;
      if (related && barEl.contains(related)) return;
      setInsertion(null);
    }

    function onDrop(e: DragEvent) {
      if (!e.dataTransfer) return;
      const parsed = parseDragPayload(e.dataTransfer);
      if (!parsed) {
        setInsertion(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const next = getInsertion(e.clientX);

      try {
        if (parsed.kind === "tab") {
          if (parsed.payload.workspaceId !== workspaceId) return;
          const moved = moveTabToZone(workspaceId, parsed.payload.tabId, {
            groupId: leafId,
            zone: "center",
            index: next.index,
          });
          if (moved) requestTabFocus(moved.tabId);
        } else {
          if (parsed.payload.workspaceId !== workspaceId) return;
          openFileAtZone(workspaceId, parsed.payload.filePaths[0], {
            groupId: leafId,
            zone: "center",
            index: next.index,
          });
        }
      } finally {
        setInsertion(null);
      }
    }

    barEl.addEventListener("dragenter", onEnter, true);
    barEl.addEventListener("dragover", onOver, true);
    barEl.addEventListener("dragleave", onLeave, true);
    barEl.addEventListener("drop", onDrop, true);

    return () => {
      barEl.removeEventListener("dragenter", onEnter, true);
      barEl.removeEventListener("dragover", onOver, true);
      barEl.removeEventListener("dragleave", onLeave, true);
      barEl.removeEventListener("drop", onDrop, true);
    };
  }, [bar, list, workspaceId, leafId]);

  return { barRef, tabsListRef, insertion };
}
