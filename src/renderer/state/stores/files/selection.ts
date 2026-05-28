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
 * Single-select: focus=path, anchor=path, paths={path}.
 *
 * The focused row is also a member of `paths` so subsequent Cmd-click
 * extensions can find it via `toggleInSelection`'s `sel.paths` base. Earlier
 * iteration left `paths` empty and relied on `getOperablePaths`'s focus
 * fallback, but the toggle reducer reads from `sel.paths` only — that gap
 * silently dropped the first-clicked row on the second (Cmd-)click. VSCode's
 * listWidget treats a single click identically (focus + selection length=1).
 */
export function singleSelection(path: string): FileSelection {
  return { focus: path, anchor: path, paths: new Set([path]) };
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

/**
 * Hierarchical select-all (VSCode parity).
 *
 * One press widens the scope by one level. The "scope" is the focused row's
 * ancestor; selection becomes that scope's visible subtree (the scope itself
 * + every flat row underneath it). When the current `sel.paths` already
 * covers the candidate scope, the scope walks one level up, so repeated
 * presses cumulatively widen until the workspace root is reached — at which
 * point the entire flat list is selected.
 *
 * Self-contained on `absPath` strings: parentDir does prefix arithmetic
 * against `rootAbsPath` so this helper keeps the "no helpers/store imports"
 * discipline this module is built on.
 */
export function selectAllHierarchical(
  sel: FileSelection,
  flatPaths: readonly string[],
  rootAbsPath: string,
): FileSelection {
  if (flatPaths.length === 0) return sel;
  const focus = sel.focus ?? flatPaths[0];

  const descendantsUnder = (scope: string): string[] => {
    if (scope === rootAbsPath) return [...flatPaths];
    const prefix = `${scope}/`;
    return flatPaths.filter((p) => p === scope || p.startsWith(prefix));
  };

  // First step: focus's immediate parent dir. Each subsequent step climbs
  // one level whenever the current sel.paths already covers the candidate.
  let scope = parentDir(focus, rootAbsPath);
  let candidate = descendantsUnder(scope);

  while (candidate.length > 0 && candidate.every((p) => sel.paths.has(p))) {
    if (scope === rootAbsPath) {
      // Ceiling reached — full flat selection.
      return { focus, anchor: focus, paths: new Set(flatPaths) };
    }
    scope = parentDir(scope, rootAbsPath);
    candidate = descendantsUnder(scope);
  }

  return { focus, anchor: focus, paths: new Set(candidate) };
}

/**
 * Parent directory of `absPath` within the workspace rooted at `rootAbsPath`.
 * Returns `rootAbsPath` when the path is the root itself, has no slash
 * structure, or its parent would otherwise fall outside the workspace.
 *
 * Kept private to this module so the path-arithmetic detail does not leak
 * into the selection vocabulary.
 */
function parentDir(absPath: string, rootAbsPath: string): string {
  if (absPath === rootAbsPath) return rootAbsPath;
  const idx = absPath.lastIndexOf("/");
  if (idx <= 0) return rootAbsPath;
  const parent = absPath.slice(0, idx);
  return parent.length < rootAbsPath.length ? rootAbsPath : parent;
}
