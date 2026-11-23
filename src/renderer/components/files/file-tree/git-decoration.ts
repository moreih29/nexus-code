import type { GitStatusEntry } from "../../../../shared/git/types";

export type GitDecorationKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict"
  | "ignored";

export function kindFromEntry(entry: GitStatusEntry): GitDecorationKind | null {
  if (entry.conflictType !== null) return "conflict";
  const xy = entry.xy;
  if (xy === "??") return "untracked";
  if (xy === "!!") return "ignored";

  const x = xy.charCodeAt(0);
  const y = xy.charCodeAt(1);
  const X = String.fromCharCode(x);
  const Y = String.fromCharCode(y);

  const workingKind = letterToKind(Y);
  if (workingKind !== null) return workingKind;
  return letterToKind(X);
}

export function letterToKind(letter: string): GitDecorationKind | null {
  switch (letter) {
    case "M":
    case "T":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "U":
      return "conflict";
    case "?":
      return "untracked";
    case "!":
      return "ignored";
    default:
      return null;
  }
}

export function priority(kind: GitDecorationKind): number {
  switch (kind) {
    case "conflict":
      return 5;
    case "deleted":
      return 4;
    case "modified":
      return 3;
    case "added":
      return 2;
    case "untracked":
      return 2;
    case "renamed":
      return 1;
    case "ignored":
      return 0;
  }
}

export function maxKind(a: GitDecorationKind, b: GitDecorationKind): GitDecorationKind {
  return priority(a) >= priority(b) ? a : b;
}

export function propagatesToParents(kind: GitDecorationKind): boolean {
  return kind !== "deleted" && kind !== "ignored";
}

export function propagateToAncestors(
  folders: Map<string, GitDecorationKind>,
  absPath: string,
  kind: GitDecorationKind,
  rootAbsPath: string,
): void {
  if (!propagatesToParents(kind)) return;
  let cursor = absPath;
  while (true) {
    const slash = cursor.lastIndexOf("/");
    if (slash <= 0) break;
    cursor = cursor.slice(0, slash);
    if (cursor === rootAbsPath || !cursor.startsWith(rootAbsPath)) break;
    const existing = folders.get(cursor);
    folders.set(cursor, existing === undefined ? kind : maxKind(existing, kind));
  }
}

export function kindToLetter(kind: GitDecorationKind): string {
  switch (kind) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "conflict":
      return "!";
    case "ignored":
      return "I";
  }
}

export function kindToTooltip(kind: GitDecorationKind): string {
  switch (kind) {
    case "modified":
      return "Modified";
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "untracked":
      return "Untracked";
    case "conflict":
      return "Conflict";
    case "ignored":
      return "Ignored";
  }
}

export function kindToColorVar(kind: GitDecorationKind): string {
  switch (kind) {
    case "modified":
      return "var(--git-status-modified-fg)";
    case "added":
      return "var(--git-status-added-fg)";
    case "deleted":
      return "var(--git-status-deleted-fg)";
    case "renamed":
      return "var(--git-status-renamed-fg)";
    case "untracked":
      return "var(--git-status-untracked-fg)";
    case "conflict":
      return "var(--git-status-conflict-fg)";
    case "ignored":
      return "var(--git-status-ignored-fg)";
  }
}
