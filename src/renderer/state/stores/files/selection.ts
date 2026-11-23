import type { FileSelection } from "./types";

export function isSelected(sel: FileSelection, path: string): boolean {
  return sel.paths.has(path);
}

export function isFocused(sel: FileSelection, path: string): boolean {
  return sel.focus === path;
}

export function getOperablePaths(sel: FileSelection): readonly string[] {
  if (sel.paths.size > 0) return [...sel.paths];
  if (sel.focus !== null) return [sel.focus];
  return [];
}

export function emptySelection(): FileSelection {
  return { focus: null, anchor: null, paths: new Set() };
}

export function singleSelection(path: string): FileSelection {
  return { focus: path, anchor: path, paths: new Set([path]) };
}

export function toggleInSelection(sel: FileSelection, path: string): FileSelection {
  const next = new Set(sel.paths);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return { focus: path, anchor: sel.anchor, paths: next };
}

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
    return singleSelection(target);
  }
  const lo = Math.min(anchorIdx, targetIdx);
  const hi = Math.max(anchorIdx, targetIdx);
  const paths = new Set(flatPaths.slice(lo, hi + 1));
  return { focus: target, anchor: effectiveAnchor, paths };
}

export function selectAll(flatPaths: readonly string[]): FileSelection {
  if (flatPaths.length === 0) return emptySelection();
  const last = flatPaths[flatPaths.length - 1];
  return {
    focus: last,
    anchor: flatPaths[0],
    paths: new Set(flatPaths),
  };
}

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

  let scope = parentDir(focus, rootAbsPath);
  let candidate = descendantsUnder(scope);

  while (candidate.length > 0 && candidate.every((p) => sel.paths.has(p))) {
    if (scope === rootAbsPath) {
      return { focus, anchor: focus, paths: new Set(flatPaths) };
    }
    scope = parentDir(scope, rootAbsPath);
    candidate = descendantsUnder(scope);
  }

  return { focus, anchor: focus, paths: new Set(candidate) };
}

function parentDir(absPath: string, rootAbsPath: string): string {
  if (absPath === rootAbsPath) return rootAbsPath;
  const idx = absPath.lastIndexOf("/");
  if (idx <= 0) return rootAbsPath;
  const parent = absPath.slice(0, idx);
  return parent.length < rootAbsPath.length ? rootAbsPath : parent;
}
