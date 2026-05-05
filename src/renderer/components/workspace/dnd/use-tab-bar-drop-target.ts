/**
 * Tab-bar drop-target hook — the second half of the workspace D&D seam.
 *
 * Owns: dragenter / dragover / dragleave / drop wiring on the outer bar
 *       wrapper (which carries `data-dnd-tab-bar`), insertion-index
 *       computation against the inner tab list, and the dispatch to
 *       moveTabToZone / openFileAtZone with `zone: "center"` and an
 *       explicit insertion index.
 *
 * Caller owns: rendering the bar wrapper with the data attribute, the
 *              inner tab list, and the "|" insertion indicator at the
 *              x position from `insertion`.
 *
 * IMPORTANT: native DOM addEventListener at capture phase, mirroring
 * `useDropTarget`. The tab-bar lives inside a portal-host React tree, so
 * React onDrop / onDropCapture would not see events from portal-mounted
 * children (Monaco / xterm). Capture phase additionally lets us run
 * before any descendants' bubble-phase handlers.
 *
 * The two-element design (bar = listener carrier, list = measurement
 * basis) lets the bar grow to the whole strip — so empty space beyond
 * the last tab and around the "+" button still counts as a tab-bar drop
 * — while the indicator stays anchored to the actual tab strip.
 */
import { useCallback, useEffect, useState } from "react";
import { moveTabToZone, openFileAtZone } from "@/state/operations";
import { DND_TAB_ITEM_SELECTOR } from "./markers";
import { hasSupportedMime, parseDragPayload } from "./payload";
import { MIME_FILE } from "./types";

export interface InsertionState {
  /** Insertion line x in coordinates relative to the tab list element. */
  x: number;
  /** Resulting tab index for the insertion. */
  index: number;
}

export interface UseTabBarDropTargetOptions {
  workspaceId: string;
  leafId: string;
}

export interface UseTabBarDropTargetResult {
  /**
   * Callback ref for the outer bar wrapper. The wrapper must carry the
   * `data-dnd-tab-bar` attribute so the group-level useDropTarget defers
   * to us via marker `closest()`.
   */
  barRef: (el: HTMLDivElement | null) => void;
  /**
   * Callback ref for the inner tab list. Used as the measurement basis
   * for `getInsertion` — the indicator's x is in this element's
   * coordinate space, and the insertion index is computed against
   * `[data-dnd-tab-item]` children.
   */
  tabsListRef: (el: HTMLDivElement | null) => void;
  /**
   * Current insertion-line state, or null when no supported drag is over
   * the bar. Caller renders the "|" indicator while non-null.
   */
  insertion: InsertionState | null;
}

export function useTabBarDropTarget(
  opts: UseTabBarDropTargetOptions,
): UseTabBarDropTargetResult {
  const { workspaceId, leafId } = opts;

  // State-backed callback refs so the effect re-runs when the elements
  // mount or change (mutable refs do not trigger effects).
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const barRef = useCallback((el: HTMLDivElement | null) => setBar(el), []);
  const tabsListRef = useCallback((el: HTMLDivElement | null) => setList(el), []);
  const [insertion, setInsertion] = useState<InsertionState | null>(null);

  useEffect(() => {
    if (!bar || !list) return;

    // querySelectorAll is run on every cursor move, so live tab-list
    // changes are picked up automatically; no `tabs.length` dep needed.
    function getInsertion(clientX: number): InsertionState {
      const items = Array.from(
        list!.querySelectorAll<HTMLElement>(DND_TAB_ITEM_SELECTOR),
      );
      const listRect = list!.getBoundingClientRect();

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
      const next = getInsertion(e.clientX);
      setInsertion((prev) =>
        prev && prev.x === next.x && prev.index === next.index ? prev : next,
      );
    }

    function onLeave(e: DragEvent) {
      if (!e.dataTransfer || !hasSupportedMime(e.dataTransfer.types)) return;
      e.stopPropagation();
      // dragleave fires for every descendant exit; only clear when the
      // cursor truly leaves the bar.
      const related = e.relatedTarget as Node | null;
      if (related && bar!.contains(related)) return;
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
          moveTabToZone(workspaceId, parsed.payload.tabId, {
            groupId: leafId,
            zone: "center",
            index: next.index,
          });
        } else {
          if (parsed.payload.workspaceId !== workspaceId) return;
          openFileAtZone(workspaceId, parsed.payload.filePath, {
            groupId: leafId,
            zone: "center",
            index: next.index,
          });
        }
      } finally {
        setInsertion(null);
      }
    }

    bar.addEventListener("dragenter", onEnter, true);
    bar.addEventListener("dragover", onOver, true);
    bar.addEventListener("dragleave", onLeave, true);
    bar.addEventListener("drop", onDrop, true);

    return () => {
      bar.removeEventListener("dragenter", onEnter, true);
      bar.removeEventListener("dragover", onOver, true);
      bar.removeEventListener("dragleave", onLeave, true);
      bar.removeEventListener("drop", onDrop, true);
    };
  }, [bar, list, workspaceId, leafId]);

  return { barRef, tabsListRef, insertion };
}
