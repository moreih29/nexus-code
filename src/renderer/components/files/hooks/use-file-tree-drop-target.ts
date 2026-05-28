/**
 * Container-level drag-and-drop target for the file-tree.
 *
 * Uses native capture-phase event listeners on the tree's scroll container so
 * drop detection works even when virtualized rows unmount during scroll. The
 * pattern mirrors `useTabBarDropTarget` and `useDropTarget` from the workspace
 * DnD system.
 *
 * Target resolution (VSCode parity):
 *   - cursor over a directory row     → that directory
 *   - cursor over a file/symlink row  → that file's parent directory
 *   - cursor over empty space         → the workspace root
 *
 * Behaviour:
 *   - dragover: resolve the drop directory, highlight its row (or the whole
 *     tree for a root drop) via `data-file-tree-dnd-target`, set dropEffect.
 *   - drop:   parse `MIME_FILE` payload, determine move vs copy (modifier key),
 *     then `movePath` (move) or `copyPathWithAutoRename` (copy).
 *   - dragleave / dragend / drop: clear target highlight.
 */

import { type RefObject, useEffect } from "react";
import { copyPathWithAutoRename, movePath } from "@/services/fs-mutations";
import { loadChildren, toggleExpand } from "@/state/operations/files";
import { parentOf } from "@/state/stores/files/helpers";
import { useFilesStore } from "@/state/stores/files/store";
import { basename, relPath } from "@/utils/path";
import { type FileDragPayload, MIME_FILE } from "../../workspace/dnd/types";

/**
 * Delay (ms) before a closed directory under the cursor auto-expands
 * during a drag. VSCode uses 500ms in its tree.ts; we match that — long
 * enough that a casual fly-over doesn't expand every folder, short
 * enough that an intentional pause feels responsive.
 */
const DRAG_EXPAND_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UseFileTreeDropTargetOptions {
  /** The tree's scroll-container ref — stable across renders, ref={} target. */
  containerRef: RefObject<HTMLDivElement | null>;
  workspaceId: string;
  workspaceRootPath: string;
}

interface DropTarget {
  /** Absolute path of the directory the drop resolves into. */
  dir: string;
  /** Element to highlight — the directory's row, or the tree for a root drop. */
  highlightEl: HTMLElement;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCopyModifier(e: DragEvent): boolean {
  const isMac = typeof window !== "undefined" && window.host?.platform === "darwin";
  return isMac ? e.altKey : e.ctrlKey;
}

function parseFilePayload(e: DragEvent): FileDragPayload | null {
  try {
    const raw = e.dataTransfer?.getData(MIME_FILE);
    if (!raw) return null;
    const parsed: { workspaceId?: string; filePath?: string } = JSON.parse(raw);
    if (typeof parsed.workspaceId !== "string" || typeof parsed.filePath !== "string") {
      return null;
    }
    return { workspaceId: parsed.workspaceId, filePath: parsed.filePath };
  } catch {
    return null;
  }
}

/** Locate the rendered row element for an absolute path, if currently mounted. */
function findRowByPath(treeEl: HTMLElement, absPath: string): HTMLElement | null {
  const rows = treeEl.querySelectorAll<HTMLElement>('[role="treeitem"][data-file-tree-row-path]');
  for (const row of rows) {
    if (row.getAttribute("data-file-tree-row-path") === absPath) return row;
  }
  return null;
}

/**
 * Resolve the directory a drop at (x, y) targets, and the element to
 * highlight. A directory row targets itself; a file row targets its parent;
 * empty space targets the workspace root (highlighting the whole tree).
 */
function resolveDropTarget(
  x: number,
  y: number,
  treeEl: HTMLElement,
  rootPath: string,
): DropTarget {
  let el = document.elementFromPoint(x, y);
  while (el && el !== treeEl && el !== document.body) {
    const treeitem = el.closest?.('[role="treeitem"]');
    if (treeitem instanceof HTMLElement) {
      const path = treeitem.getAttribute("data-file-tree-row-path");
      const type = treeitem.getAttribute("data-file-tree-row-type");
      if (path) {
        if (type === "dir") {
          return { dir: path, highlightEl: treeitem };
        }
        // File / symlink row → drop into its parent directory.
        const parent = parentOf(path, rootPath);
        return { dir: parent, highlightEl: findRowByPath(treeEl, parent) ?? treeEl };
      }
      break;
    }
    el = (el as HTMLElement).parentElement;
  }
  // Empty space → workspace root; highlight the whole tree.
  return { dir: rootPath, highlightEl: findRowByPath(treeEl, rootPath) ?? treeEl };
}

let currentTarget: HTMLElement | null = null;

function clearTargetHighlight(): void {
  if (currentTarget) {
    currentTarget.removeAttribute("data-file-tree-dnd-target");
    currentTarget = null;
  }
}

function setTargetHighlight(el: HTMLElement): void {
  if (currentTarget && currentTarget !== el) {
    clearTargetHighlight();
  }
  if (currentTarget === el) return;
  el.setAttribute("data-file-tree-dnd-target", "");
  currentTarget = el;
}

// ---------------------------------------------------------------------------
// Drag-over auto-expand (VSCode parity)
//
// When the cursor lingers over a CLOSED directory row during a drag, we
// expand it after `DRAG_EXPAND_DELAY_MS` so the user can drill into deep
// targets without releasing the drag. The state is module-scoped (mirroring
// `currentTarget` above) because there is one drag at a time per browser
// window. Every drag-leave / drag-end / drop site clears it.
// ---------------------------------------------------------------------------

let expandHoverPath: string | null = null;
let expandHoverTimer: ReturnType<typeof setTimeout> | null = null;

function clearExpandHover(): void {
  if (expandHoverTimer !== null) {
    clearTimeout(expandHoverTimer);
    expandHoverTimer = null;
  }
  expandHoverPath = null;
}

/**
 * Schedule an auto-expand of `absPath` if the cursor stays over it long
 * enough. No-op when the path is already the scheduled target, when it
 * is already expanded, or when the workspace state has no record of it.
 */
function scheduleExpandHover(workspaceId: string, absPath: string): void {
  if (expandHoverPath === absPath) return;
  clearExpandHover();

  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;
  const node = tree.nodes.get(absPath);
  if (!node || node.type !== "dir") return;
  // Already expanded — nothing to do.
  if (tree.expanded.has(absPath)) return;

  expandHoverPath = absPath;
  expandHoverTimer = setTimeout(() => {
    // Re-check on fire — the user may have collapsed/moved during the wait.
    const currentTree = useFilesStore.getState().trees.get(workspaceId);
    const currentNode = currentTree?.nodes.get(absPath);
    if (currentNode?.type === "dir" && !currentTree?.expanded.has(absPath)) {
      void toggleExpand(workspaceId, absPath);
    }
    expandHoverPath = null;
    expandHoverTimer = null;
  }, DRAG_EXPAND_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFileTreeDropTarget({
  containerRef,
  workspaceId: wsId,
  workspaceRootPath: rootPath,
}: UseFileTreeDropTargetOptions): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleDragOver = (e: DragEvent): void => {
      // Only handle our own file MIME.
      if (!e.dataTransfer?.types.includes(MIME_FILE)) return;
      e.preventDefault();

      const copy = isCopyModifier(e);
      const { dir, highlightEl } = resolveDropTarget(e.clientX, e.clientY, el, rootPath);

      // Self-drop is a no-op for moves only — a copy into the same folder is
      // valid (it produces a "… copy" via auto-rename). Payload may be absent
      // during dragover (some browsers withhold getData), so only skip when we
      // can positively confirm the same-parent move.
      if (!copy) {
        const payload = parseFilePayload(e);
        if (payload && parentOf(payload.filePath, rootPath) === dir) {
          clearTargetHighlight();
          clearExpandHover();
          e.dataTransfer.dropEffect = "none";
          return;
        }
      }

      setTargetHighlight(highlightEl);
      e.dataTransfer.dropEffect = copy ? "copy" : "move";

      // Auto-expand the hovered closed folder after a short dwell. Files
      // (where `dir` is the parent) get clearExpandHover so the timer
      // doesn't fire on a passing file row.
      const targetIsDirRow = highlightEl.getAttribute("data-file-tree-row-type") === "dir";
      if (targetIsDirRow) {
        scheduleExpandHover(wsId, dir);
      } else {
        clearExpandHover();
      }
    };

    const handleDrop = async (e: DragEvent): Promise<void> => {
      if (!e.dataTransfer?.types.includes(MIME_FILE)) return;
      e.preventDefault();
      clearTargetHighlight();
      clearExpandHover();

      const payload = parseFilePayload(e);
      if (!payload || payload.workspaceId !== wsId) return;

      const copy = isCopyModifier(e);
      const { dir } = resolveDropTarget(e.clientX, e.clientY, el, rootPath);

      // Move into the file's current folder is a no-op.
      if (!copy && parentOf(payload.filePath, rootPath) === dir) return;

      try {
        if (copy) {
          const name = basename(payload.filePath);
          const fromRel = relPath(payload.filePath, rootPath);
          const toRel = relPath(`${dir}/${name}`, rootPath);
          await copyPathWithAutoRename({
            workspaceId: wsId,
            fromRelPath: fromRel,
            toRelPath: toRel,
          });
        } else {
          await movePath({
            workspaceId: wsId,
            workspaceRootPath: rootPath,
            srcAbsPath: payload.filePath,
            dstDirAbsPath: dir,
          });
        }
        await loadChildren(wsId, dir);
      } catch {
        // Errors surface via toasts within movePath / copyPathWithAutoRename.
      }
    };

    const handleDragEnd = (): void => {
      clearTargetHighlight();
      clearExpandHover();
    };

    el.addEventListener("dragover", handleDragOver, true);
    el.addEventListener("drop", handleDrop, true);
    el.addEventListener("dragleave", handleDragEnd, true);
    el.addEventListener("dragend", handleDragEnd, true);

    return () => {
      el.removeEventListener("dragover", handleDragOver, true);
      el.removeEventListener("drop", handleDrop, true);
      el.removeEventListener("dragleave", handleDragEnd, true);
      el.removeEventListener("dragend", handleDragEnd, true);
      clearTargetHighlight();
      clearExpandHover();
    };
  }, [containerRef, wsId, rootPath]);
}
