/**
 * Container-level drag-and-drop target for the file-tree.
 *
 * Uses native capture-phase event listeners on the tree's scroll container so
 * drop detection works even when virtualized rows unmount during scroll. The
 * pattern mirrors `useTabBarDropTarget` and `useDropTarget` from the workspace
 * DnD system.
 *
 * Behaviour:
 *   - dragover: hit-test DOM rows via `elementFromPoint`, filter for directory
 *     rows, apply `data-file-tree-dnd-target` highlighting, set dropEffect.
 *   - drop:   parse `MIME_FILE` payload, determine move vs copy (modifier key),
 *     validate (no self-drop, target must be a dir within the same workspace),
 *     call `movePath` or `ipcCallResult("fs","copyFile",…)`.
 *   - dragleave / drop: clear target highlight.
 */

import { useEffect, type RefObject } from "react";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { movePath } from "@/services/fs-mutations";
import { loadChildren } from "@/state/operations/files";
import { parentOf } from "@/state/stores/files/helpers";
import { basename, relPath } from "@/utils/path";
import { MIME_FILE, type FileDragPayload } from "../../workspace/dnd/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UseFileTreeDropTargetOptions {
  /** The tree's scroll-container ref — stable across renders, ref={} target. */
  containerRef: RefObject<HTMLDivElement | null>;
  workspaceId: string;
  workspaceRootPath: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCopyModifier(e: DragEvent): boolean {
  const isMac =
    typeof window !== "undefined" && window.host?.platform === "darwin";
  return isMac ? e.altKey : e.ctrlKey;
}

function parseFilePayload(e: DragEvent): FileDragPayload | null {
  try {
    const raw = e.dataTransfer?.getData(MIME_FILE);
    if (!raw) return null;
    const parsed: { workspaceId?: string; filePath?: string } = JSON.parse(raw);
    if (
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.filePath !== "string"
    ) {
      return null;
    }
    return { workspaceId: parsed.workspaceId, filePath: parsed.filePath };
  } catch {
    return null;
  }
}

function findTargetDirElement(
  x: number,
  y: number,
  treeEl: HTMLElement,
): HTMLElement | null {
  // Start from the element under the cursor and walk up to find a
  // [role="treeitem"] that also has data-file-tree-row-type="dir".
  let el = document.elementFromPoint(x, y);
  while (el && el !== treeEl && el !== document.body) {
    const treeitem = el.closest?.('[role="treeitem"]');
    if (treeitem instanceof HTMLElement) {
      const type = treeitem.getAttribute("data-file-tree-row-type");
      if (type === "dir") return treeitem;
      // Hit a non-dir treeitem row — this is not a valid drop target.
      return null;
    }
    // Element is not inside a treeitem — check its parent.
    el = (el as HTMLElement).parentElement;
  }
  return null;
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

      const target = findTargetDirElement(e.clientX, e.clientY, el);
      if (!target) {
        clearTargetHighlight();
        e.dataTransfer.dropEffect = "none";
        return;
      }

      const targetPath = target.getAttribute("data-file-tree-row-path");
      if (!targetPath || targetPath === rootPath) {
        clearTargetHighlight();
        e.dataTransfer.dropEffect = "none";
        return;
      }

      // Self-drop prevention — compute after resolving the drag payload.
      const payload = parseFilePayload(e);
      if (payload) {
        if (parentOf(payload.filePath, rootPath) === targetPath) {
          clearTargetHighlight();
          e.dataTransfer.dropEffect = "none";
          return;
        }
      }

      setTargetHighlight(target);
      e.dataTransfer.dropEffect = isCopyModifier(e) ? "copy" : "move";
    };

    const handleDrop = async (e: DragEvent): Promise<void> => {
      if (!e.dataTransfer?.types.includes(MIME_FILE)) return;
      e.preventDefault();
      clearTargetHighlight();

      const payload = parseFilePayload(e);
      if (!payload || payload.workspaceId !== wsId) return;

      const target = findTargetDirElement(e.clientX, e.clientY, el);
      if (!target) return;

      const dstDir = target.getAttribute("data-file-tree-row-path");
      if (!dstDir || dstDir === rootPath) return;

      // Self-drop: no-op if the file is already inside this folder.
      if (parentOf(payload.filePath, rootPath) === dstDir) return;

      const copy = isCopyModifier(e);

      try {
        if (copy) {
          const fromRel = relPath(payload.filePath, rootPath);
          const toAbs = `${dstDir}/${basename(payload.filePath)}`;
          const toRel = relPath(toAbs, rootPath);
          unwrapIpcResult(
            await ipcCallResult("fs", "copyFile", {
              workspaceId: wsId,
              fromRelPath: fromRel,
              toRelPath: toRel,
            }),
          );
        } else {
          await movePath({
            workspaceId: wsId,
            workspaceRootPath: rootPath,
            srcAbsPath: payload.filePath,
            dstDirAbsPath: dstDir,
          });
        }
        await loadChildren(wsId, dstDir);
      } catch {
        // Errors surface via toasts within movePath / unwrapIpcResult.
      }
    };

    const handleDragEnd = (): void => {
      clearTargetHighlight();
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
    };
  }, [containerRef, wsId, rootPath]);
}