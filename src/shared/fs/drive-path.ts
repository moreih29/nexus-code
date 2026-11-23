const DRIVE_PATH = /^[A-Za-z]:([\\/]|$)/;

const URI_DRIVE_PATH = /^\/[A-Za-z]:(\/|$)/;

export function isDrivePath(path: string): boolean {
  return DRIVE_PATH.test(path);
}

export function toSlashPath(path: string): string {
  if (!isDrivePath(path)) return path;
  return `${path[0].toUpperCase()}${path.slice(1).replaceAll("\\", "/")}`;
}

export function sameFolder(a: string, b: string): boolean {
  const key = (path: string) => toSlashPath(path).replace(/[\\/]+$/, "");
  return key(a) === key(b);
}

export function toNativeDrivePath(path: string): string {
  if (!isDrivePath(path)) return path;
  return path.replaceAll("/", "\\");
}

export function fromUriPath(path: string): string {
  return URI_DRIVE_PATH.test(path) ? toSlashPath(path.slice(1)) : path;
}

export function toUriPath(path: string): string {
  if (!isDrivePath(path)) return path;
  const slashed = toSlashPath(path);
  return `/${slashed[0].toLowerCase()}${slashed.slice(1)}`;
}
