// Windows drive paths in the form the renderer works with.
//
// Renderer code joins and splits absolute paths on `/`. A local Windows
// path arrives as `C:\work\demo`; it is kept as `C:/work/demo`, with the
// drive letter in upper case. Windows, Node and Go all accept that form as
// is, so it can go back to main or the agent unchanged.
//
// A POSIX absolute path starts with `/`, never with a drive letter, so these
// helpers need no platform check.

const DRIVE_PATH = /^[A-Za-z]:([\\/]|$)/;

/** In a URI path the drive comes after a slash: `/C:/work`, `/c:/work`. */
const URI_DRIVE_PATH = /^\/[A-Za-z]:(\/|$)/;

/** True for a Windows path that starts with a drive letter: `C:\x`, `c:/x`. */
export function isDrivePath(path: string): boolean {
  return DRIVE_PATH.test(path);
}

/** `c:\work\demo` → `C:/work/demo`. Any other path comes back unchanged. */
export function toSlashPath(path: string): string {
  if (!isDrivePath(path)) return path;
  return `${path[0].toUpperCase()}${path.slice(1).replaceAll("\\", "/")}`;
}

/** `C:/work/demo` → `C:\work\demo`, for showing or copying a path. */
export function toNativeDrivePath(path: string): string {
  if (!isDrivePath(path)) return path;
  return path.replaceAll("/", "\\");
}

/**
 * The path a file URI decodes to: `/c:/work/demo` → `C:/work/demo`. Any
 * other path comes back unchanged.
 */
export function fromUriPath(path: string): string {
  return URI_DRIVE_PATH.test(path) ? toSlashPath(path.slice(1)) : path;
}

/**
 * The path a file URI encodes: `C:/work/demo` → `/c:/work/demo`. The drive
 * letter is lower case, as in the URIs Monaco prints and VS Code sends to
 * language servers.
 */
export function toUriPath(path: string): string {
  if (!isDrivePath(path)) return path;
  const slashed = toSlashPath(path);
  return `/${slashed[0].toLowerCase()}${slashed.slice(1)}`;
}
