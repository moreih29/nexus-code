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

  if (!root) return absPath.startsWith("/");

  if (target === root) return true;
  return target.startsWith(`${root}/`);
}
