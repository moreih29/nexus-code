/**
 * Pure helpers that turn porcelain v2 status entries into file-tree
 * decoration descriptors.
 *
 * Lives in the file-tree component folder because it is renderer-only and the
 * sole consumer is the file tree row. Kept dependency-free so the git store
 * selector can re-use it without dragging React in.
 *
 * The decoration vocabulary intentionally mirrors VSCode's git extension
 * (`references/vscode/extensions/git/src/repository.ts`) so users carry their
 * mental model across:
 *   - letters: M / A / D / R / C / U / ! / I
 *   - colors:  added=success / modified=warning / deleted+conflict=error /
 *              untracked=info / renamed+ignored=muted
 *
 * Folder propagation rule (matches VSCode):
 *   - Modified / Added / Untracked / Renamed / Conflict propagate up the
 *     ancestor chain so a parent folder hints at "something inside changed".
 *   - Deleted does NOT propagate — a deleted child should not paint its
 *     parent folder red (the folder itself still exists).
 *   - Ignored does NOT propagate — a folder containing some ignored files is
 *     not itself ignored.
 *   - When multiple kinds reach the same folder, the highest priority wins.
 */
import type { GitStatusEntry } from "../../../../shared/git/types";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Closed set of decoration kinds the file tree understands. Maps roughly to
 * VSCode's `Status` enum but flattened to the renderer's needs.
 */
export type GitDecorationKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict"
  | "ignored";

// ---------------------------------------------------------------------------
// xy → kind
// ---------------------------------------------------------------------------

/**
 * Converts a porcelain v2 `xy` two-char status code to a decoration kind.
 *
 * The two characters represent index (X) and working tree (Y) state. Either
 * being non-space means the file has *some* change. Order of precedence:
 *   1. Conflict markers (entry-level `conflictType` already disambiguates,
 *      but the xy codes alone — UU / AA / DD / AU / UA / DU / UD — are
 *      sufficient and we use them as the canonical signal).
 *   2. Untracked (`??`) and ignored (`!!`).
 *   3. The first non-space side wins by mapping its letter to a kind. The
 *      working-tree side (Y) is checked first to match how the tree user
 *      perceives a file ("did I just edit this?"); staged-only changes
 *      fall back to the index side (X).
 */
export function kindFromEntry(entry: GitStatusEntry): GitDecorationKind | null {
  if (entry.conflictType !== null) return "conflict";
  const xy = entry.xy;
  if (xy === "??") return "untracked";
  if (xy === "!!") return "ignored";

  const x = xy.charCodeAt(0);
  const y = xy.charCodeAt(1);
  const X = String.fromCharCode(x);
  const Y = String.fromCharCode(y);

  // Working tree side takes priority — it is what the user just did.
  const workingKind = letterToKind(Y);
  if (workingKind !== null) return workingKind;
  return letterToKind(X);
}

/**
 * Translates one porcelain status letter to a decoration kind.
 * Returns null for space (no change on that side).
 */
function letterToKind(letter: string): GitDecorationKind | null {
  switch (letter) {
    case "M":
    case "T": // type changed — symlink/file/exec bit
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C": // copied — same visual treatment as rename
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

// ---------------------------------------------------------------------------
// Priority — when multiple kinds reach the same path (folder propagation,
// or a rename that touches both endpoints), the higher number wins.
// ---------------------------------------------------------------------------

/**
 * Numeric priority (higher = wins) when two decorations compete for the same
 * absPath. The order matches VSCode's `Resource.priority` rule of thumb:
 * conflict noisier than modify, modify noisier than rename, ignored quietest.
 */
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

/**
 * Returns the kind with higher priority. Ties resolve to `a`.
 */
export function maxKind(a: GitDecorationKind, b: GitDecorationKind): GitDecorationKind {
  return priority(a) >= priority(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Folder propagation
// ---------------------------------------------------------------------------

/**
 * Returns true when the kind should propagate up the directory chain.
 *
 *   - deleted does not propagate — a deleted file should not turn its
 *     parent folder red; the folder still exists.
 *   - ignored does not propagate — only files matching .gitignore are
 *     ignored; their parent folders are normal.
 */
export function propagatesToParents(kind: GitDecorationKind): boolean {
  return kind !== "deleted" && kind !== "ignored";
}

/**
 * Walks ancestors of `absPath` up to (but not including) `rootAbsPath`,
 * upserting `kind` into `folders` if it has higher priority than what is
 * already there.
 *
 * The root itself is excluded — decorating the workspace root row with a
 * git letter is noise (the source-control panel already summarises this).
 */
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
    // Stop at (and exclude) the workspace root.
    if (cursor === rootAbsPath || !cursor.startsWith(rootAbsPath)) break;
    const existing = folders.get(cursor);
    folders.set(cursor, existing === undefined ? kind : maxKind(existing, kind));
  }
}

// ---------------------------------------------------------------------------
// Presentation — letter + CSS class
// ---------------------------------------------------------------------------

/**
 * Single-character glyph rendered in the trailing chip. Matches the Source
 * Control panel's `GitStatusBadge` letter vocabulary so the two surfaces
 * read the same.
 */
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

/**
 * Human-readable tooltip text. Kept short — full classification (e.g.
 * "Conflict: Both Modified") belongs on the source-control panel row.
 */
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

/**
 * Resolves the chip glyph's color CSS variable. The filename text itself is
 * intentionally NOT colored (design.md §1 monochromatic principle) — the
 * chip's single character is the only colored surface introduced by the
 * decoration.
 */
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
