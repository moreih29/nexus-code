import { isDrivePath, toNativeDrivePath, toSlashPath } from "../../shared/fs/drive-path";
import { workspacePathParts } from "./path";

function isUncPath(path: string): boolean {
  return /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path);
}

export function isPeerWindowsPath(path: string): boolean {
  return isDrivePath(path) || isUncPath(path);
}

export function peerPathRelativeTo(path: string, folder: string): string | null {
  const windows = isPeerWindowsPath(folder);
  if (isPeerWindowsPath(path) !== windows) return null;

  function parts(absolute: string) {
    if (!absolute || absolute.includes("\0")) return null;
    const slashed = windows ? absolute.replaceAll("\\", "/") : absolute;
    if (!slashed.startsWith("/") && !/^[a-z]:\//i.test(slashed)) return null;
    const segments = slashed.split("/").filter(Boolean);
    return segments.some((part) => part === "." || part === "..") ? null : segments;
  }

  const parent = parts(folder);
  const file = parts(path);
  if (!parent || !file || file.length < parent.length) return null;
  const matches = parent.every((part, index) =>
    windows ? part.toLowerCase() === file[index].toLowerCase() : part === file[index],
  );
  return matches ? file.slice(parent.length).join("/") : null;
}

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

export function joinPeerPath(folder: string, relative: string): string {
  const unc = isUncPath(folder);
  const root = unc ? folder.replaceAll("\\", "/") : toSlashPath(folder);
  const path = `${root.replace(/\/+$/, "")}/${relative}`;
  return unc ? path.replaceAll("/", "\\") : toNativeDrivePath(path);
}

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
