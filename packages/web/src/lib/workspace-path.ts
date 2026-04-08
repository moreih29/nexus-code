/**
 * Prepare a workspace absolute path for use in URL path segments.
 * Hono's /:path{.+} route uses greedy match, so literal slashes are needed
 * for the router to capture the full path. Only the leading slash is stripped
 * to avoid a double-slash in the URL.
 *
 * Note: This means paths with URL-special characters (%, #, ?) may break.
 * For query parameter usage, use encodeURIComponent directly.
 */
export function encodeWorkspacePath(absolutePath: string): string {
  return absolutePath.startsWith('/') ? absolutePath.slice(1) : absolutePath
}
