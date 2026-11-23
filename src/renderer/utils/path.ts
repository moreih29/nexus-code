import { shownPath, slashWindowsPath } from "../../shared/fs/relative-path";

export { isUnder, relativeTo, shownPath } from "../../shared/fs/relative-path";
export { isWithinWorkspace } from "../../shared/fs/workspace-path";

export function basename(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

export function workspacePathParts(filePath: string, workspaceRoot: string) {
  const shown = shownPath(slashWindowsPath(filePath), workspaceRoot);
  const separator = shown.lastIndexOf("/") + 1;
  return { directory: shown.slice(0, separator), fileName: shown.slice(separator) };
}
