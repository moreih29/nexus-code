// Tiny path helpers for renderer code that already speaks in absolute
// POSIX-style paths (the `filePath` strings stored in EditorTabProps).
//
// We can't use node's `path` module here — the renderer is a sandboxed
// browser context. These helpers are deliberately minimal: they assume
// `/` separators and don't try to handle Windows backslashes (the main
// process normalizes incoming paths already).

/**
 * Last `/`-separated segment of a path. Returns the input unchanged for
 * paths without a separator (so `basename("foo")` → `"foo"`, matching
 * node's `path.posix.basename` for that case).
 */
export function basename(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}
