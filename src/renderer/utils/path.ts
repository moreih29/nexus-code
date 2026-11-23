import { isDrivePath, toSlashPath } from "../../shared/fs/drive-path";

export { isWithinWorkspace } from "../../shared/fs/workspace-path";

export function basename(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

export function relPath(absPath: string, rootPath: string): string {
  const rootWithSep = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  if (absPath === rootPath) return "";
  if (absPath.startsWith(rootWithSep)) return absPath.slice(rootWithSep.length);
  return absPath;
}

export function shownPath(path: string, cwd: string): string {
  const slashed = path.replace(/\\/g, "/");
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const rel = relPath(slashed, base);
  return rel && rel !== slashed ? rel : path;
}

const UNC_PATH = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;

function slashWindowsPath(path: string): string {
  return UNC_PATH.test(path) ? path.replaceAll("\\", "/") : toSlashPath(path);
}

export function workspacePathParts(filePath: string, workspaceRoot: string) {
  const path = slashWindowsPath(filePath);
  const root = slashWindowsPath(workspaceRoot).replace(/\/+$/, "");
  const prefix = `${root}/`;
  const inside =
    workspaceRoot !== "" &&
    (isDrivePath(path) || UNC_PATH.test(path)
      ? path.toLowerCase().startsWith(prefix.toLowerCase())
      : path.startsWith(prefix));
  const shown = inside ? path.slice(prefix.length) : path;
  const separator = shown.lastIndexOf("/") + 1;
  return { directory: shown.slice(0, separator), fileName: shown.slice(separator) };
}
