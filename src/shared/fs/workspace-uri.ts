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

// ---------------------------------------------------------------------------
// Untitled URI helpers — workspace-scoped cache key for unsaved buffers.
//
// Format:  untitled://{workspaceId}/Untitled-{N}
//
// Using the `untitled` scheme communicates "no on-disk backing" to both
// Monaco and our own plumbing (LSP bridge, fs-watcher skip). The authority
// slot carries the workspaceId so that two workspaces that each open their
// first untitled file get distinct Monaco models and distinct cache entries.
//
// This URI doubles as both the cacheUri (model-cache key) and the Monaco
// monacoUri (monaco.editor.createModel), so no separate translation step
// is needed in the cache layer.
// ---------------------------------------------------------------------------

const UNTITLED_SCHEME = "untitled";
const UNTITLED_URI_PREFIX = `${UNTITLED_SCHEME}://`;

/**
 * Build a workspace-scoped untitled URI.
 *
 *   untitled://{workspaceId}/Untitled-{untitledIndex}
 */
export function untitledCacheUriFor(workspaceId: string, untitledIndex: number): string {
  if (workspaceId.length === 0) {
    throw new Error("untitledCacheUriFor: workspaceId must be non-empty");
  }
  if (!Number.isInteger(untitledIndex) || untitledIndex < 1) {
    throw new Error(`untitledCacheUriFor: untitledIndex must be a positive integer, got ${untitledIndex}`);
  }
  return `${UNTITLED_URI_PREFIX}${workspaceId}/Untitled-${untitledIndex}`;
}

/**
 * Parse an untitled cacheUri produced by `untitledCacheUriFor`. Returns
 * null when the URI does not match the expected format.
 */
export function parseUntitledCacheUri(
  uri: string,
): { workspaceId: string; untitledIndex: number } | null {
  if (!uri.startsWith(UNTITLED_URI_PREFIX)) return null;
  const rest = uri.slice(UNTITLED_URI_PREFIX.length);
  // rest = "{workspaceId}/Untitled-{N}"
  const slashIdx = rest.indexOf("/");
  if (slashIdx <= 0) return null;
  const workspaceId = rest.slice(0, slashIdx);
  const namePart = rest.slice(slashIdx + 1); // "Untitled-{N}"
  const match = /^Untitled-(\d+)$/.exec(namePart);
  if (!match) return null;
  const untitledIndex = parseInt(match[1], 10);
  if (!Number.isFinite(untitledIndex) || untitledIndex < 1) return null;
  return { workspaceId, untitledIndex };
}
