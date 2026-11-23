import { isDrivePath, toSlashPath } from "./drive-path";

const UNC_PATH = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;

export function isWindowsPath(path: string): boolean {
  return isDrivePath(path) || UNC_PATH.test(path);
}

export function slashWindowsPath(path: string): string {
  return UNC_PATH.test(path) ? path.replaceAll("\\", "/") : toSlashPath(path);
}

function folded(path: string, windows: boolean): string {
  return windows ? slashWindowsPath(path).toLowerCase() : path;
}

function trimmedBase(base: string): string {
  return base.replace(/\/+$/, "");
}

export function isUnder(path: string, base: string): boolean {
  if (!path || !base) return false;
  const windows = isWindowsPath(base);
  const root = trimmedBase(folded(base, windows));
  const target = folded(path, windows);
  if (root === "") return target.startsWith("/");
  return trimmedBase(target) === root || target.startsWith(`${root}/`);
}

export function relativeTo(path: string, base: string): string {
  if (!path || !base || !isUnder(path, base)) return path;
  const windows = isWindowsPath(base);
  const slashed = windows ? slashWindowsPath(path) : path;
  const root = trimmedBase(windows ? slashWindowsPath(base) : base);
  return slashed.slice(root.length).replace(/^\/+/, "");
}

export function shownPath(path: string, base: string): string {
  return relativeTo(path, base) || path;
}
