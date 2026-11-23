import { isDrivePath } from "./drive-path";
import { absolutePathToFileUri, fileUriToAbsolutePath } from "./file-uri";

export const WORKSPACE_URI_SCHEME = "nexus-ws";
const WORKSPACE_URI_PREFIX = `${WORKSPACE_URI_SCHEME}://`;

export function workspaceUriFor(workspaceId: string, absolutePath: string): string {
  if (workspaceId.length === 0) {
    throw new Error("workspaceUriFor: workspaceId must be non-empty");
  }
  if (!absolutePath.startsWith("/") && !isDrivePath(absolutePath)) {
    throw new Error(`workspaceUriFor: absolutePath must be absolute, got ${absolutePath}`);
  }
  const fileUri = absolutePathToFileUri(absolutePath);
  const encodedPath = fileUri.slice("file://".length);
  return `${WORKSPACE_URI_PREFIX}${workspaceId}${encodedPath}`;
}

export function parseWorkspaceUri(
  uri: string,
): { workspaceId: string; absolutePath: string } | null {
  if (!uri.startsWith(WORKSPACE_URI_PREFIX)) return null;
  const rest = uri.slice(WORKSPACE_URI_PREFIX.length);
  const pathStart = rest.indexOf("/");
  if (pathStart <= 0) return null;
  const workspaceId = rest.slice(0, pathStart);
  const encodedPath = rest.slice(pathStart);
  const absolutePath = fileUriToAbsolutePath(`file://${encodedPath}`);
  if (absolutePath === null) return null;
  return { workspaceId, absolutePath };
}

export function workspaceUriToFileUri(uri: string): string | null {
  const parsed = parseWorkspaceUri(uri);
  if (!parsed) return null;
  return absolutePathToFileUri(parsed.absolutePath);
}

export function fileUriToWorkspaceUri(workspaceId: string, fileUri: string): string | null {
  const absolutePath = fileUriToAbsolutePath(fileUri);
  if (absolutePath === null) return null;
  return workspaceUriFor(workspaceId, absolutePath);
}

const UNTITLED_SCHEME = "untitled";
const UNTITLED_URI_PREFIX = `${UNTITLED_SCHEME}://`;

export function untitledCacheUriFor(workspaceId: string, untitledIndex: number): string {
  if (workspaceId.length === 0) {
    throw new Error("untitledCacheUriFor: workspaceId must be non-empty");
  }
  if (!Number.isInteger(untitledIndex) || untitledIndex < 1) {
    throw new Error(
      `untitledCacheUriFor: untitledIndex must be a positive integer, got ${untitledIndex}`,
    );
  }
  return `${UNTITLED_URI_PREFIX}${workspaceId}/Untitled-${untitledIndex}`;
}

export function parseUntitledCacheUri(
  uri: string,
): { workspaceId: string; untitledIndex: number } | null {
  if (!uri.startsWith(UNTITLED_URI_PREFIX)) return null;
  const rest = uri.slice(UNTITLED_URI_PREFIX.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx <= 0) return null;
  const workspaceId = rest.slice(0, slashIdx);
  const namePart = rest.slice(slashIdx + 1);
  const match = /^Untitled-(\d+)$/.exec(namePart);
  if (!match) return null;
  const untitledIndex = parseInt(match[1], 10);
  if (!Number.isFinite(untitledIndex) || untitledIndex < 1) return null;
  return { workspaceId, untitledIndex };
}
