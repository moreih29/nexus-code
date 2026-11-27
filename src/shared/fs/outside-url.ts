export const OUTSIDE_HOST_SUFFIX = ".outside";

export function outsideWorkspaceOf(host: string): string | null {
  if (!host.endsWith(OUTSIDE_HOST_SUFFIX)) return null;
  return host.slice(0, -OUTSIDE_HOST_SUFFIX.length) || null;
}

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

export function isAbsoluteOutsidePath(path: string): boolean {
  return path.startsWith("/") || DRIVE_PATH.test(path);
}

export function isDrivePath(path: string): boolean {
  return DRIVE_PATH.test(path);
}

export type WindowsPathKind = "drive" | "unc" | "device" | "rooted" | "relative";

const DEVICE_PATH = /^[\\/](?:[\\/][?.]|\?\?)(?:[\\/]|$)/;

export function windowsPathKind(path: string): WindowsPathKind {
  if (DEVICE_PATH.test(path)) return "device";
  if (/^[\\/]{2}/.test(path)) return "unc";
  if (DRIVE_PATH.test(path)) return "drive";
  return /^[\\/]/.test(path) ? "rooted" : "relative";
}

export function isNetworkOrDevicePath(path: string): boolean {
  const kind = windowsPathKind(path);
  return kind === "unc" || kind === "device";
}

export function isDevicePath(path: string): boolean {
  return windowsPathKind(path) === "device";
}

const AUTOMOUNT_TOPS = new Set(["net", "network"]);
const FIRMLINK_ROOT = ["system", "volumes", "data"];

export function isAutoMountPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part.toLowerCase());
  }
  const firmlinked = FIRMLINK_ROOT.every((part, i) => parts[i] === part);
  return AUTOMOUNT_TOPS.has(parts[firmlinked ? FIRMLINK_ROOT.length : 0] ?? "");
}

function decodedLink(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

export function networkLinkPath(target: string): string | null {
  if (!isNetworkLink(target)) return null;
  const link = decodedLink(target.trim()).trim();
  if (!/^file:/i.test(link)) return link;
  const rest = link.slice("file:".length).replace(/\\/g, "/");
  const local = /^\/\/(?:localhost)?(?=\/)/i.exec(rest);
  return local ? rest.slice(local[0].length) : rest;
}

export function isNetworkLink(target: string): boolean {
  const link = decodedLink(target.trim()).trim();
  if (!/^file:/i.test(link)) return isNetworkOrDevicePath(link);
  const rest = link.slice("file:".length).replace(/\\/g, "/");
  if (/^\/{3}\//.test(rest)) return true;
  const host = /^\/\/([^/]*)/.exec(rest)?.[1];
  if (host === undefined) return false;
  if (host !== "" && host.toLowerCase() !== "localhost") return true;
  return isNetworkOrDevicePath(rest.slice(2 + host.length));
}
