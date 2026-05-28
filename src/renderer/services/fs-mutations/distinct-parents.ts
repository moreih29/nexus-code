/**
 * distinctParents — reduce a path list to its minimal ancestor set.
 *
 * Given a list of absolute paths, returns only those paths for which no
 * other entry in the list is an ancestor.  Equivalent to VSCode's
 * `distinctParents` in fileActions.ts (L97): sort by length ascending,
 * then walk the sorted list and keep only paths whose prefix is not
 * already in the output.
 *
 * Rules:
 *   - Deduplication: duplicate paths are collapsed to one entry.
 *   - Prefix check: a path P is dropped when some already-kept path A
 *     satisfies `P === A || P.startsWith(A + "/")`.
 *   - The trailing-slash suffix guard (`A + "/"`) prevents the
 *     `/foo` vs `/foobar` collision: `/foobar` does NOT start with
 *     `/foo/`, so it is kept even when `/foo` is already in the output.
 *   - Order: output is sorted by ascending path length (shortest first).
 *     This is a deterministic canonical form, not the original list order.
 *
 * Pure function — no side effects, no IPC, no store access.
 */
export function distinctParents(paths: readonly string[]): string[] {
  // Deduplicate and sort ascending by length (shorter = higher ancestor).
  const unique = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const p of unique) {
    const alreadyCovered = out.some((parent) => p === parent || p.startsWith(`${parent}/`));
    if (!alreadyCovered) out.push(p);
  }
  return out;
}
