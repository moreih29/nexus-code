import { isDrivePath, toNativeDrivePath, toSlashPath } from "../../shared/fs/drive-path";
import { workspacePathParts } from "./path";

function isUncPath(path: string): boolean {
  return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(path);
}

function isPeerWindowsPath(path: string): boolean {
  return isDrivePath(path) || isUncPath(path);
}

/** Key for tab and tree identity on the serving filesystem. */
export function peerPathKey(path: string): string {
  return isPeerWindowsPath(path)
    ? path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
    : path.replace(/\/+$/, "") || "/";
}

export function peerRelativePath(path: string, root: string): string {
  if (peerPathKey(path) === peerPathKey(root)) return ".";
  if (isUncPath(root) && peerPathKey(path).startsWith(`${peerPathKey(root)}/`)) {
    const prefix = root.replaceAll("\\", "/").replace(/\/+$/, "");
    return path.replaceAll("\\", "/").slice(prefix.length + 1);
  }
  const { directory, fileName } = workspacePathParts(path, root);
  return directory + fileName;
}

/** Search results use slash-separated relative paths, including from Windows peers. */
export function joinPeerPath(folder: string, relative: string): string {
  const unc = isUncPath(folder);
  const root = unc ? folder.replaceAll("\\", "/") : toSlashPath(folder);
  const path = `${root.replace(/\/+$/, "")}/${relative}`;
  return unc ? path.replaceAll("/", "\\") : toNativeDrivePath(path);
}

/** An RPC result names a file under the given workspace. */
export function peerSearchResultPath(root: string, relative: string): string | null {
  if (
    !relative ||
    relative.includes("\0") ||
    isPeerWindowsPath(relative) ||
    (isPeerWindowsPath(root) && /[\\:]/.test(relative))
  ) {
    return null;
  }
  if (relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return joinPeerPath(root, relative);
}
