/**
 * Builds a `nexus-workspace://` URL for a file inside a workspace.
 *
 * URI encoding rationale:
 *   - `workspaceId` is a hex UUID (e.g. "a1b2c3d4-…") so it is technically
 *     safe as a URL host, but we encode it as a safety net against future
 *     id formats that may include non-ASCII or reserved characters.
 *   - `relPath` segments are percent-encoded individually so that path
 *     separators are preserved and file names containing spaces or special
 *     characters survive the round-trip through the URL parser in the main
 *     process.
 */

/**
 * Returns a `nexus-workspace://<workspaceId>/<relPath>` URL string.
 *
 * @param workspaceId  UUID of the target workspace.
 * @param relPath      Relative path from the workspace root.  Both forward
 *                     slashes and Windows backslashes are accepted.
 */
export function buildWorkspaceUrl(workspaceId: string, relPath: string): string {
  // Normalise Windows backslashes to forward slashes so the URL path is
  // well-formed on all platforms.
  const forwardSlashPath = relPath.replace(/\\/g, "/");
  const encodedSegments = forwardSlashPath.split("/").map(encodeURIComponent).join("/");
  return `nexus-workspace://${encodeURIComponent(workspaceId)}/${encodedSegments}`;
}
