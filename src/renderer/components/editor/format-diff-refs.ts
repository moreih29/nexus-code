// Diff ref display formatter.
//
// A pure formatter for showing a (leftRef, rightRef) pair briefly in tab chips, headers,
// etc. The output convention follows the git CLI's `A..B` (e.g. `git diff HEAD..WORKING`),
// reusing the mental model users already have.

import { EMPTY_TREE } from "./diff-refs";

const SPECIAL_REFS: ReadonlySet<string> = new Set(["HEAD", "INDEX", "WORKING"]);
const SHA_LIKE_RE = /^[0-9a-f]{7,}$/i;

/**
 * Renders a single ref for compact tab display.
 *  - `EMPTY_TREE` sentinel → `∅` (unborn repo "before first commit").
 *  - `HEAD` / `INDEX` / `WORKING` → returned as-is (already short, semantic).
 *  - Hex SHA (7+ chars) → first 7 chars (git's default short-sha length).
 *  - Everything else (branch names, tags, `HEAD~1`, …) → returned as-is.
 */
export function formatDiffRef(ref: string): string {
  if (ref === EMPTY_TREE) return "∅";
  if (SPECIAL_REFS.has(ref)) return ref;
  if (SHA_LIKE_RE.test(ref)) return ref.slice(0, 7);
  return ref;
}

/**
 * Compact `left..right` suffix for diff tab labels. Mirrors git's
 * "two-dot range" notation so the suffix reads as natural diff vocabulary.
 */
export function formatDiffRefPair(leftRef: string, rightRef: string): string {
  return `${formatDiffRef(leftRef)}..${formatDiffRef(rightRef)}`;
}
