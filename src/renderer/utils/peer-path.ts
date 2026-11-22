import { isDrivePath, toNativeDrivePath, toSlashPath } from "../../shared/fs/drive-path";
import { workspacePathParts } from "./path";

/** Key for tab and tree identity on the serving filesystem. */
export function peerPathKey(path: string): string {
  return isDrivePath(path)
    ? toSlashPath(path).replace(/\/+$/, "").toLowerCase()
    : path.replace(/\/+$/, "") || "/";
}

export function peerRelativePath(path: string, root: string): string {
  if (peerPathKey(path) === peerPathKey(root)) return ".";
  const { directory, fileName } = workspacePathParts(path, root);
  return directory + fileName;
}

/** Search results use slash-separated relative paths, including from Windows peers. */
export function joinPeerPath(folder: string, relative: string): string {
  const root = isDrivePath(folder) ? toSlashPath(folder) : folder;
  const path = `${root.replace(/\/+$/, "")}/${relative}`;
  return toNativeDrivePath(path);
}

/** An RPC result names a file under the given workspace. */
export function peerSearchResultPath(root: string, relative: string): string | null {
  if (!relative || relative.includes("\0") || (isDrivePath(root) && relative.includes("\\"))) {
    return null;
  }
  if (relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return joinPeerPath(root, relative);
}
