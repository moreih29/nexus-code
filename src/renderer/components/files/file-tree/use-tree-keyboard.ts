/**
 * WAI-ARIA tree keyboard interaction hook.
 *
 * Implements the ARIA authoring practices for the `tree` role:
 * https://www.w3.org/WAI/ARIA/apg/patterns/treeview/
 *
 * No I/O. The hook is a pure input→output computation over the rows array
 * plus React state. Callers own the DOM refs and any focus restoration.
 */

import { useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns keyboard event handler and per-row ARIA prop getter for a
 * WAI-ARIA tree widget.
 *
 * Key bindings (ARIA tree pattern):
 *  ↑ / ↓   Move focus up / down (no wrap-around at edges).
 *  ←       If dir and expanded → collapse (onToggle). If collapsed or file
 *           → move to parent dir row.
 *  →       If dir and collapsed → expand (onToggle). If expanded → move to
 *           first child.
 *  Home    Move to first row.
 *  End     Move to last row.
 *  Enter   dir → toggle, file/leaf/match → activate.
 *  Space   Activate current row (mirrors browser default Enter for buttons
 *           but kept here for consistency with ARIA practices).
 */
export function useTreeKeyboard(opts: UseTreeKeyboardOptions): UseTreeKeyboardResult {
  const { rows, focusedIndex, onMove, onToggle, onActivate } = opts;

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
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
              // Expand.
              onToggle(current.relPath, true);
            } else {
              // Already expanded → move to first child.
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
            // Collapse.
            onToggle(current.relPath, false);
          } else {
            // Move to parent dir.
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
    },
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
