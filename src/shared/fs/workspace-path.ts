import { reducePosixSegments } from "./posix-segments";

function normalizePosix(p: string): string {
  const result = reducePosixSegments(p, {
    emptySegments: "keep",
    leadingParents: "discard",
  }).join("/");
  return result.startsWith("/") ? result : `/${result}`;
}

export function isWithinWorkspace(absPath: string, workspaceRootPath: string): boolean {
  if (!workspaceRootPath || !absPath) return false;

  const root = normalizePosix(workspaceRootPath).replace(/\/+$/, "");
  const target = normalizePosix(absPath).replace(/\/+$/, "");

  if (!root) return absPath.startsWith("/");

  if (target === root) return true;
  return target.startsWith(`${root}/`);
}
