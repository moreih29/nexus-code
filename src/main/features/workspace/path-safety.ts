import path from "node:path";
import { requireLocalWorkspace, requireWorkspace } from "./guards";
import type { WorkspaceManager } from "./manager";

export function resolveLocalWorkspacePath(
  manager: WorkspaceManager,
  workspaceId: string,
  relPath: string,
  operation = "local filesystem access",
): string {
  const workspace = requireLocalWorkspace(manager, workspaceId, operation);

  const rootPath = workspace.location.rootPath;
  const abs = path.resolve(rootPath, relPath || ".");
  const rel = path.relative(rootPath, abs);

  if (rel === "" || rel === ".") {
    return abs;
  }
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("path escapes workspace root");
  }

  return abs;
}

export function assertWorkspaceExists(manager: WorkspaceManager, workspaceId: string): void {
  requireWorkspace(manager, workspaceId);
}
