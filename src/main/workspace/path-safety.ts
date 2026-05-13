/**
 * Path-resolution + workspace-membership guards used by local-only main
 * process handlers.
 *
 * Go agent methods own workspace path safety for file operations. This helper
 * remains for Electron-owned local integrations such as reveal-in-Finder and
 * the temporary TypeScript watcher.
 */
import path from "node:path";
import { requireLocalWorkspace, requireWorkspace } from "./workspace-guards";
import type { WorkspaceManager } from "./workspace-manager";

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
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes workspace root");
  }

  return abs;
}

export function assertWorkspaceExists(manager: WorkspaceManager, workspaceId: string): void {
  requireWorkspace(manager, workspaceId);
}
