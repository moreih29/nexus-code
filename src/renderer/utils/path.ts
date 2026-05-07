// Tiny path helpers for renderer code that already speaks in absolute
// POSIX-style paths (the `filePath` strings stored in EditorTabProps).
//
// We can't use node's `path` module here — the renderer is a sandboxed
// browser context. These helpers are deliberately minimal: they assume
// `/` separators and don't try to handle Windows backslashes (the main
// process normalizes incoming paths already).

/** Resolve `.` and `..` segments in a POSIX absolute path without Node. */
function normalizePosix(p: string): string {
  const parts = p.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  const result = resolved.join("/");
  // Preserve the leading `/` — an absolute path should always start with one.
  return result.startsWith("/") ? result : `/${result}`;
}

/**
 * Last `/`-separated segment of a path. Returns the input unchanged for
 * paths without a separator (so `basename("foo")` → `"foo"`, matching
 * node's `path.posix.basename` for that case).
 */
export function basename(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

/**
 * Compute a workspace-relative POSIX path from an absolute file path.
 * Returns the absolute path unchanged when the file is not under the
 * given root (mirrors VSCode's `Copy Relative Path` falling back to the
 * absolute path for files outside the workspace).
 */
export function relPath(absPath: string, rootPath: string): string {
  const rootWithSep = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  if (absPath === rootPath) return "";
  if (absPath.startsWith(rootWithSep)) return absPath.slice(rootWithSep.length);
  return absPath;
}

/**
 * Returns true when `absPath` is inside (or exactly equal to) `workspaceRootPath`.
 *
 * Both paths are POSIX-normalized (`.` / `..` resolved) and trailing slashes
 * are stripped before comparison, so naive prefix matches like `/workspace2`
 * starting with `/workspace` are rejected correctly.
 */
export function isWithinWorkspace(absPath: string, workspaceRootPath: string): boolean {
  if (!workspaceRootPath || !absPath) return false;

  const root = normalizePosix(workspaceRootPath).replace(/\/+$/, "");
  const target = normalizePosix(absPath).replace(/\/+$/, "");

  if (!root) return false;

  if (target === root) return true;
  return target.startsWith(`${root}/`);
}
