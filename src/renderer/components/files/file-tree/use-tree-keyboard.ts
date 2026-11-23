import { useCallback } from "react";

export interface TreeKeyboardRow {
  kind: "dir" | "file" | "match" | "leaf";
  relPath: string;
  isExpanded?: boolean;
  parentRelPath?: string;
}

export interface UseTreeKeyboardOptions {
  rows: TreeKeyboardRow[];
  focusedIndex: number;
  onMove: (next: number) => void;
  onToggle: (relPath: string, expanded: boolean) => void;
  onActivate: (row: TreeKeyboardRow) => void;
}

export interface TreeRowProps {
  tabIndex: number;
  "aria-level"?: number;
  "aria-expanded"?: boolean;
  "aria-setsize"?: number;
  "aria-posinset"?: number;
  role: string;
}

export interface UseTreeKeyboardResult {
  onKeyDown: (e: KeyboardEvent) => void;
  getRowProps: (idx: number) => TreeRowProps;
}

export function handleTreeKey(
  e: Pick<KeyboardEvent, "key" | "preventDefault">,
  opts: UseTreeKeyboardOptions,
): void {
  const { rows, focusedIndex, onMove, onToggle, onActivate } = opts;
  const len = rows.length;
  if (len === 0) return;

  const current = rows[focusedIndex];

  switch (e.key) {
    case "ArrowDown": {
      e.preventDefault();
      if (focusedIndex < len - 1) onMove(focusedIndex + 1);
      break;
    }

    case "ArrowUp": {
      e.preventDefault();
      if (focusedIndex > 0) onMove(focusedIndex - 1);
      break;
    }

    case "ArrowRight": {
      e.preventDefault();
      if (!current) break;
      if (current.kind === "dir") {
        if (!current.isExpanded) {
          onToggle(current.relPath, true);
        } else {
          const firstChild = rows.findIndex(
            (r, i) => i > focusedIndex && r.parentRelPath === current.relPath,
          );
          if (firstChild !== -1) onMove(firstChild);
        }
      }
      break;
    }

    case "ArrowLeft": {
      e.preventDefault();
      if (!current) break;
      if (current.kind === "dir" && current.isExpanded) {
        onToggle(current.relPath, false);
      } else {
        const parentRelPath = current.parentRelPath;
        if (parentRelPath !== undefined && parentRelPath !== "") {
          const parentIdx = rows.findIndex((r) => r.relPath === parentRelPath);
          if (parentIdx !== -1) onMove(parentIdx);
        }
      }
      break;
    }

    case "Home": {
      e.preventDefault();
      onMove(0);
      break;
    }

    case "End": {
      e.preventDefault();
      onMove(len - 1);
      break;
    }

    case "Enter": {
      e.preventDefault();
      if (!current) break;
      if (current.kind === "dir") {
        onToggle(current.relPath, !current.isExpanded);
      } else {
        onActivate(current);
      }
      break;
    }

    case " ": {
      e.preventDefault();
      if (!current) break;
      onActivate(current);
      break;
    }

    default:
      break;
  }
}

export function useTreeKeyboard(opts: UseTreeKeyboardOptions): UseTreeKeyboardResult {
  const { rows, focusedIndex, onMove, onToggle, onActivate } = opts;

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => handleTreeKey(e, { rows, focusedIndex, onMove, onToggle, onActivate }),
    [rows, focusedIndex, onMove, onToggle, onActivate],
  );

  const getRowProps = useCallback(
    (idx: number): TreeRowProps => {
      return {
        role: "treeitem",
        tabIndex: idx === focusedIndex ? 0 : -1,
      };
    },
    [focusedIndex],
  );

  return { onKeyDown, getRowProps };
}
