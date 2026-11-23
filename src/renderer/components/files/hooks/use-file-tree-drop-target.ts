import i18next from "i18next";
import { type RefObject, useEffect } from "react";
import { showToast } from "@/components/ui/toast";
import { copyPathWithAutoRename, movePath } from "@/services/fs-mutations";
import {
  type BatchFailure,
  partialFailureMessage,
  reportedFailure,
  thrownFailure,
} from "@/services/fs-mutations/batch-failure";
import { loadChildren, toggleExpand } from "@/state/operations/files";
import { joinPath, parentOf } from "@/state/stores/files/helpers";
import { useFilesStore } from "@/state/stores/files/store";
import { basename, relativeTo } from "@/utils/path";
import { createLogger } from "../../../../shared/log/renderer";
import { MIME_FILE } from "../../../types/workbench-dnd";
import { isMac } from "../../../utils/platform";
import { parseFileDragPayload } from "../../../utils/workbench-dnd-payload";

const log = createLogger("dnd-drop");

const DRAG_EXPAND_DELAY_MS = 500;

interface UseFileTreeDropTargetOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  workspaceId: string;
  workspaceRootPath: string;
}

interface DropTarget {
  dir: string;
  highlightEl: HTMLElement;
}

function isCopyModifier(e: DragEvent): boolean {
  return isMac() ? e.altKey : e.ctrlKey;
}

function parseFilePayload(e: DragEvent) {
  if (!e.dataTransfer) return null;
  return parseFileDragPayload(e.dataTransfer);
}

function findRowByPath(treeEl: HTMLElement, absPath: string): HTMLElement | null {
  const rows = treeEl.querySelectorAll<HTMLElement>('[role="treeitem"][data-file-tree-row-path]');
  for (const row of rows) {
    if (row.getAttribute("data-file-tree-row-path") === absPath) return row;
  }
  return null;
}

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
        const parent = parentOf(path, rootPath);
        return { dir: parent, highlightEl: findRowByPath(treeEl, parent) ?? treeEl };
      }
      break;
    }
    el = (el as HTMLElement).parentElement;
  }
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

let expandHoverPath: string | null = null;
let expandHoverTimer: ReturnType<typeof setTimeout> | null = null;

function clearExpandHover(): void {
  if (expandHoverTimer !== null) {
    clearTimeout(expandHoverTimer);
    expandHoverTimer = null;
  }
  expandHoverPath = null;
}

function scheduleExpandHover(workspaceId: string, absPath: string): void {
  if (expandHoverPath === absPath) return;
  clearExpandHover();

  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;
  const node = tree.nodes.get(absPath);
  if (!node || node.type !== "dir") return;
  if (tree.expanded.has(absPath)) return;

  expandHoverPath = absPath;
  expandHoverTimer = setTimeout(() => {
    const currentTree = useFilesStore.getState().trees.get(workspaceId);
    const currentNode = currentTree?.nodes.get(absPath);
    if (currentNode?.type === "dir" && !currentTree?.expanded.has(absPath)) {
      void toggleExpand(workspaceId, absPath);
    }
    expandHoverPath = null;
    expandHoverTimer = null;
  }, DRAG_EXPAND_DELAY_MS);
}

export interface DropFilePathsInput {
  workspaceId: string;
  workspaceRootPath: string;
  filePaths: readonly string[];
  dir: string;
  copy: boolean;
}

export async function dropFilePaths({
  workspaceId,
  workspaceRootPath,
  filePaths,
  dir,
  copy,
}: DropFilePathsInput): Promise<void> {
  if (!copy && filePaths.every((p) => parentOf(p, workspaceRootPath) === dir)) return;

  const hasCycle = filePaths.some((p) => dir === p || dir.startsWith(`${p}/`));
  if (hasCycle) {
    showToast({
      kind: "warning",
      message: i18next.t("files:fileTree.dropTarget.cycleError"),
    });
    return;
  }

  let attempted = 0;
  let successCount = 0;
  let firstFailure: BatchFailure | null = null;

  for (const srcAbsPath of filePaths) {
    if (!copy && parentOf(srcAbsPath, workspaceRootPath) === dir) continue;
    attempted += 1;

    let ok = false;
    try {
      if (copy) {
        const name = basename(srcAbsPath);
        const fromRel = relativeTo(srcAbsPath, workspaceRootPath);
        const toRel = relativeTo(joinPath(dir, name), workspaceRootPath);
        ok = await copyPathWithAutoRename({
          workspaceId,
          fromRelPath: fromRel,
          toRelPath: toRel,
        });
      } else {
        ok = await movePath({
          workspaceId,
          workspaceRootPath,
          srcAbsPath,
          dstDirAbsPath: dir,
        });
      }
    } catch (err: unknown) {
      ok = false;
      if (firstFailure === null) {
        firstFailure = thrownFailure(srcAbsPath, err);
      } else {
        log.error(`failed: ${srcAbsPath}: ${(err as Error).message}`);
      }
    }

    if (ok) {
      successCount += 1;
    } else if (firstFailure === null) {
      firstFailure = reportedFailure(srcAbsPath);
    }
  }

  if (successCount > 0) {
    await loadChildren(workspaceId, dir);
  }

  const total = attempted;
  if (total >= 2) {
    if (firstFailure === null) {
      showToast({
        kind: "info",
        message: copy
          ? i18next.t("files:fileTree.dropTarget.copied", { count: total })
          : i18next.t("files:fileTree.dropTarget.moved", { count: total }),
      });
    } else {
      showToast({
        kind: "error",
        message: partialFailureMessage(
          copy
            ? "files:fileTree.dropTarget.copiedPartial"
            : "files:fileTree.dropTarget.movedPartial",
          successCount,
          total,
          firstFailure,
        ),
      });
    }
  }
}

export function useFileTreeDropTarget({
  containerRef,
  workspaceId: wsId,
  workspaceRootPath: rootPath,
}: UseFileTreeDropTargetOptions): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes(MIME_FILE)) return;
      e.preventDefault();

      const copy = isCopyModifier(e);
      const { dir, highlightEl } = resolveDropTarget(e.clientX, e.clientY, el, rootPath);

      if (!copy) {
        const payload = parseFilePayload(e);
        if (payload?.filePaths.every((p) => parentOf(p, rootPath) === dir)) {
          clearTargetHighlight();
          clearExpandHover();
          e.dataTransfer.dropEffect = "none";
          return;
        }
      }

      setTargetHighlight(highlightEl);
      e.dataTransfer.dropEffect = copy ? "copy" : "move";

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
      await dropFilePaths({
        workspaceId: wsId,
        workspaceRootPath: rootPath,
        filePaths: payload.filePaths,
        dir,
        copy,
      });
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
