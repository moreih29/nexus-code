// Where the `nexus-workspace://` protocol serves a file outside a
// workspace's root that a Claude tab links: under the workspace's own host
// with this suffix, the file's absolute path as the URL's path. Main serves
// only what a tab granted (main's outside-grants).

export const OUTSIDE_HOST_SUFFIX = ".outside";

/** The workspace whose outside files a URL host serves, or null for a plain workspace host. */
export function outsideWorkspaceOf(host: string): string | null {
  if (!host.endsWith(OUTSIDE_HOST_SUFFIX)) return null;
  return host.slice(0, -OUTSIDE_HOST_SUFFIX.length) || null;
}

/** A Windows path from its drive, with either slash: `C:\…`, `C:/…`. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Whether `path` names a file by its absolute path, as one outside the
 * workspace is named rather than by its path under the root: from `/` on a
 * POSIX host, or from its drive on Windows (`C:\…`, `C:/…`).
 */
export function isAbsoluteOutsidePath(path: string): boolean {
  return path.startsWith("/") || DRIVE_PATH.test(path);
}

/** Whether `path` is a Windows path from its drive. */
export function isDrivePath(path: string): boolean {
  return DRIVE_PATH.test(path);
}
