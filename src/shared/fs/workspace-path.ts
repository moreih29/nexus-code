import { reducePosixSegments } from "./posix-segments";
import { isUnder } from "./relative-path";

function normalizePosix(p: string): string {
  const result = reducePosixSegments(p, {
    emptySegments: "keep",
    leadingParents: "discard",
  }).join("/");
  return result.startsWith("/") ? result : `/${result}`;
}

export function isWithinWorkspace(absPath: string, workspaceRootPath: string): boolean {
  if (!workspaceRootPath || !absPath) return false;
  return isUnder(normalizePosix(absPath), normalizePosix(workspaceRootPath));
}
