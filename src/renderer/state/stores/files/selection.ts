/**
 * Pure selection-model helpers. No Zustand / React imports.
 *
 * Mirrors the VSCode listWidget.ts anchor/focus/selection Trait triad.
 * All functions are referentially transparent: given the same inputs they
 * return the same output and have no side effects.
 */

import type { FileSelection } from "./types";

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** True when `path` is in the explicit selection set. */
export function isSelected(sel: FileSelection, path: string): boolean {
  return sel.paths.has(path);
}

/** True when `path` is the current keyboard focus. */
export function isFocused(sel: FileSelection, path: string): boolean {
  return sel.focus === path;
}

// ---------------------------------------------------------------------------
// Derived operable-paths
// ---------------------------------------------------------------------------

/**
 * Returns the paths that commands (copy, delete, etc.) should operate on.
 *
 * VSCode rule: if the selection set is non-empty the command acts on it;
 * otherwise the command acts on the focus row alone.
 */
export function getOperablePaths(sel: FileSelection): readonly string[] {
  if (sel.paths.size > 0) return [...sel.paths];
  if (sel.focus !== null) return [sel.focus];
  return [];
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Produce a fresh empty selection. */
export function emptySelection(): FileSelection {
  return { focus: null, anchor: null, paths: new Set() };
}

/**
 * Single-select: focus=path, anchor=path, paths={} (empty — single focus is
 * the implicit selection, consistent with `getOperablePaths` above).
 */
export function singleSelection(path: string): FileSelection {
  return { focus: path, anchor: path, paths: new Set() };
}

// ---------------------------------------------------------------------------
// Mutations (immutable — return new FileSelection)
// ---------------------------------------------------------------------------

/**
 * Toggle `path` in/out of the selection set.  Focus moves to `path`;
 * anchor is preserved so a subsequent Shift+click still extends correctly.
 */
export function toggleInSelection(sel: FileSelection, path: string): FileSelection {
  const next = new Set(sel.paths);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return { focus: path, anchor: sel.anchor, paths: next };
}

/**
 * Extend the selection from the anchor to `target` using `flatPaths` as the
 * ordered list.  If anchor is null the current focus is used as the anchor.
 *
 * The resulting selection set is the closed range [anchor, target] (inclusive
 * at both ends, order-insensitive). Paths outside the range are cleared —
 * Shift+click always replaces the previous range (VSCode parity).
 */
export function extendSelection(
  sel: FileSelection,
  anchor: string | null,
  target: string,
  flatPaths: readonly string[],
): FileSelection {
  const effectiveAnchor = anchor ?? sel.focus ?? target;
  const anchorIdx = flatPaths.indexOf(effectiveAnchor);
  const targetIdx = flatPaths.indexOf(target);
  if (anchorIdx < 0 || targetIdx < 0) {
    // Fallback: just single-select target when either bound is not in flat.
    return singleSelection(target);
  }
  const lo = Math.min(anchorIdx, targetIdx);
  const hi = Math.max(anchorIdx, targetIdx);
  const paths = new Set(flatPaths.slice(lo, hi + 1));
  return { focus: target, anchor: effectiveAnchor, paths };
}

/**
 * Select all visible paths. focus and anchor both move to the last item
 * (VSCode parity: Cmd+A moves focus to the end of the list).
 */
export function selectAll(flatPaths: readonly string[]): FileSelection {
  if (flatPaths.length === 0) return emptySelection();
  const last = flatPaths[flatPaths.length - 1];
  return {
    focus: last,
    anchor: flatPaths[0],
    paths: new Set(flatPaths),
  };
}
