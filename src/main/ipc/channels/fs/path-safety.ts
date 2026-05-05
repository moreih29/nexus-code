/**
 * Path-resolution + workspace-membership guards used by every fs handler.
 *
 * Every workspaceId+relPath pair flows through `resolveSafe` so we never
 * read or write paths that escape the workspace root. `assertWorkspaceExists`
 * is the no-op-resolution variant for handlers that operate on a workspace
 * but not a path inside it (getExpanded / setExpanded).
 */
import path from "node:path";
import type { WorkspaceManager } from "../../../workspace/workspace-manager";

export function resolveSafe(
  manager: WorkspaceManager,
  workspaceId: string,
  relPath: string,
): string {
  const workspace = manager.list().find((w) => w.id === workspaceId);
  if (!workspace) {
    throw new Error(`workspace not found: ${workspaceId}`);
  }

  const rootPath = workspace.rootPath;
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
  if (!manager.list().some((w) => w.id === workspaceId)) {
    throw new Error(`workspace not found: ${workspaceId}`);
  }
}
