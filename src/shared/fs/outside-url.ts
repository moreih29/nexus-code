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

export function isNetworkOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

export function isDevicePath(path: string): boolean {
  return /^[\\/]{2}[?.][\\/]/.test(path);
}

function decodedLink(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

export function isNetworkLink(target: string): boolean {
  const link = decodedLink(target.trim()).trim();
  if (!/^file:/i.test(link)) return isNetworkOrDevicePath(link);
  const rest = link.slice("file:".length).replace(/\\/g, "/");
  if (/^\/{3}\//.test(rest)) return true;
  const host = /^\/\/([^/]*)/.exec(rest)?.[1];
  return host !== undefined && host !== "" && host.toLowerCase() !== "localhost";
}
