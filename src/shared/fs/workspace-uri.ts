// Workspace-scoped URI encoding for the renderer model cache.
//
// The model cache must distinguish the SAME physical file opened from
// DIFFERENT workspace registrations. Using a plain `file://${absPath}` URI
// makes the cache key collide across workspaces — the second open returns
// the first workspace's entry, and the LSP routing on the main side
// (uriIndex) stays pinned to the first workspaceId. Switching workspaces
// or closing the first one then breaks the second tab's hover/completion.
//
// We solve this by attaching the workspaceId into the URI itself via a
// dedicated `nexus-ws` scheme:
//
//   nexus-ws://{workspaceId}{absolutePath}
//
// The authority component holds the workspaceId (UUID — URL-safe by
// construction) and the path component carries the absolute file path
// exactly as it would appear in a file:// URI. Monaco accepts arbitrary
// URI schemes for model identity, so this gives us a per-workspace
// namespace at zero cost.
//
// The cacheUri is RENDERER-ONLY. The main side (agent-host) converts
// to/from a plain `file://${absPath}` lspUri at the LSP server boundary:
//   - Outbound: cacheUri → file:// before forwarding didOpen / hover / …
//     to the LSP server (tsserver expects file://).
//   - Inbound: file:// → cacheUri before emitting diagnostics events
//     (server identity supplies the workspaceId).
//
// See agent-host.ts for the conversion seam and cache.ts for the
// renderer-side construction.

import { absolutePathToFileUri, fileUriToAbsolutePath } from "./file-uri";

export const WORKSPACE_URI_SCHEME = "nexus-ws";
const WORKSPACE_URI_PREFIX = `${WORKSPACE_URI_SCHEME}://`;

/**
 * Build a workspace-scoped cacheUri. Both inputs are validated:
 *  - `workspaceId` must be non-empty (we trust it is URL-safe; UUIDs and
 *    nanoids both satisfy this).
 *  - `absolutePath` must be absolute (start with `/`); relative paths are
 *    rejected because the round-trip with file-uri.ts would silently
 *    produce a malformed URI.
 */
export function workspaceUriFor(workspaceId: string, absolutePath: string): string {
  if (workspaceId.length === 0) {
    throw new Error("workspaceUriFor: workspaceId must be non-empty");
  }
  if (!absolutePath.startsWith("/")) {
    throw new Error(`workspaceUriFor: absolutePath must be absolute, got ${absolutePath}`);
  }
  // Reuse the file-uri encoder so the path segment matches what we would
  // send as a file:// URI (same component encoding, same casing). The
  // resulting URI's path component begins with the absolutePath's leading
  // slash, so it can be sliced back out cleanly in the inverse helper.
  const fileUri = absolutePathToFileUri(absolutePath); // file://${encoded}
  const encodedPath = fileUri.slice("file://".length);
  return `${WORKSPACE_URI_PREFIX}${workspaceId}${encodedPath}`;
}

/**
 * Inverse of `workspaceUriFor`. Returns null when the URI is not one we
 * produced — protects callers from accidentally slicing an unrelated
 * string. Use this rather than slicing the prefix off inline; the
 * prefix shape is owned here.
 */
export function parseWorkspaceUri(
  uri: string,
): { workspaceId: string; absolutePath: string } | null {
  if (!uri.startsWith(WORKSPACE_URI_PREFIX)) return null;
  const rest = uri.slice(WORKSPACE_URI_PREFIX.length);
  // The authority ends at the first `/` (the absolute path's leading
  // slash). If there is no `/`, the URI has no path → invalid.
  const pathStart = rest.indexOf("/");
  if (pathStart <= 0) return null;
  const workspaceId = rest.slice(0, pathStart);
  const encodedPath = rest.slice(pathStart);
  const absolutePath = fileUriToAbsolutePath(`file://${encodedPath}`);
  if (absolutePath === null) return null;
  return { workspaceId, absolutePath };
}

/**
 * Convenience: convert a workspace-scoped cacheUri to the file:// URI we
 * forward to the LSP server. Returns null when the input is not a
 * workspace-scoped URI — callers should detect this and either reject
 * the request or fall back to treating the URI as already file-scoped.
 */
export function workspaceUriToFileUri(uri: string): string | null {
  const parsed = parseWorkspaceUri(uri);
  if (!parsed) return null;
  return absolutePathToFileUri(parsed.absolutePath);
}

/**
 * Convenience: lift a file:// URI back into the workspace scope. Used on
 * the main side when an LSP server emits a notification (diagnostics,
 * applyEdit, …) and we need to address the right Monaco model. The
 * workspaceId comes from the server's own context.
 */
export function fileUriToWorkspaceUri(workspaceId: string, fileUri: string): string | null {
  const absolutePath = fileUriToAbsolutePath(fileUri);
  if (absolutePath === null) return null;
  return workspaceUriFor(workspaceId, absolutePath);
}
