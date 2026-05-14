import type { WorkspaceLocation, WorkspaceMeta } from "../../../shared/types/workspace";
import type { WorkspaceManager } from "./manager";

type LocalWorkspace = WorkspaceMeta & {
  location: Extract<WorkspaceLocation, { kind: "local" }>;
};

type SshWorkspace = WorkspaceMeta & {
  location: Extract<WorkspaceLocation, { kind: "ssh" }>;
};

export class UnsupportedSshWorkspaceError extends Error {
  readonly name = "UnsupportedSshWorkspaceError";

  constructor(
    public readonly workspaceId: string,
    public readonly operation: string,
  ) {
    super(`SSH workspaces do not support ${operation}: ${workspaceId}`);
  }
}

export function requireWorkspace(manager: WorkspaceManager, workspaceId: string): WorkspaceMeta {
  const workspace = findWorkspace(manager, workspaceId);
  if (!workspace) {
    throw new Error(`workspace not found: ${workspaceId}`);
  }
  return workspace;
}

export function findWorkspace(
  manager: WorkspaceManager,
  workspaceId: string,
): WorkspaceMeta | undefined {
  return manager.list().find((candidate) => candidate.id === workspaceId);
}

export function isSshWorkspace(workspace: WorkspaceMeta): workspace is SshWorkspace {
  return workspace.location.kind === "ssh";
}

export function isLocalWorkspace(workspace: WorkspaceMeta): workspace is LocalWorkspace {
  return workspace.location.kind === "local";
}

export function requireLocalWorkspace(
  manager: WorkspaceManager,
  workspaceId: string,
  operation: string,
): LocalWorkspace {
  const workspace = requireWorkspace(manager, workspaceId);
  if (!isLocalWorkspace(workspace)) {
    throw new UnsupportedSshWorkspaceError(workspaceId, operation);
  }
  return workspace;
}
