/**
 * Tasks: workspaces on git worktrees of another workspace's repository.
 *
 * A task is a hidden child workspace (`WorkspaceMeta.task`), so it gets its
 * own tabs, terminals, file tree, git state and agent channel like any
 * workspace. Its worktree lives under the worktrees root of the host the
 * parent lives on (~/.nexus-code/worktrees/<repo>-<hash>/<branch>), on a new
 * branch started from the parent's HEAD.
 */

import fs from "node:fs";
import path from "node:path";
import type { WorkspaceLocation, WorkspaceMeta } from "../../../shared/types/workspace";
import { GitError } from "../git/domain/error";
import type { GitRepository } from "../git/domain/repository";
import type { WorkspaceManager } from "../workspace/manager";
import { repoFolderName, subPathInRepo, taskSlug, uniqueName } from "./naming";

export type TaskErrorKind =
  /** No such workspace, or it is a task itself. */
  | "not-found"
  /** The workspace is not in a git repository. */
  | "not-a-repo"
  /** An SSH workspace that has not connected yet. */
  | "not-connected"
  /** The name leaves nothing usable for a branch. */
  | "invalid-name"
  /** The worktree has changes; removing it needs `force`. */
  | "worktree-dirty";

export class TaskError extends Error {
  constructor(
    readonly kind: TaskErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

export interface TaskServiceDeps {
  readonly manager: Pick<WorkspaceManager, "list" | "create" | "remove" | "getWorktreesRoot">;
  /** The repository a workspace is in, or null outside one. */
  readonly getRepository: (workspaceId: string) => Promise<GitRepository | null>;
  /** Whether a local path exists; injectable for tests. */
  readonly localPathExists?: (p: string) => boolean;
}

export interface CreateTaskArgs {
  readonly parentId: string;
  readonly name: string;
}

export interface RemoveTaskArgs {
  readonly id: string;
  /** Remove the worktree even when it has changes. */
  readonly force: boolean;
  /** Delete the task's branch too. */
  readonly deleteBranch: boolean;
}

/** Creates the worktree and branch for a new task, and its workspace. */
export async function createTask(
  deps: TaskServiceDeps,
  { parentId, name }: CreateTaskArgs,
): Promise<WorkspaceMeta> {
  const workspaces = deps.manager.list();
  const parent = workspaces.find((workspace) => workspace.id === parentId);
  if (!parent || parent.task) throw new TaskError("not-found", `no workspace ${parentId}`);

  const slug = taskSlug(name);
  if (slug === "") throw new TaskError("invalid-name", `no branch name in "${name}"`);

  const repo = await deps.getRepository(parentId);
  if (!repo) throw new TaskError("not-a-repo", `${parent.rootPath} is not in a git repository`);

  const root = deps.manager.getWorktreesRoot(parentId);
  if (!root) throw new TaskError("not-connected", `${parent.name} is not connected`);

  const remote = parent.location.kind === "ssh";
  const join = remote ? path.posix.join : path.join;
  const repoDir = join(root, repoFolderName(parent));
  const branches = new Set((await repo.listBranches()).local);
  const pathExists = deps.localPathExists ?? fs.existsSync;
  const usedFolders = new Set(
    workspaces.flatMap((workspace) =>
      workspace.task ? [workspace.task.worktreePath.replace(/\\/g, "/")] : [],
    ),
  );
  const branch = uniqueName(slug, (candidate) => {
    const folder = join(repoDir, candidate);
    return (
      branches.has(candidate) ||
      usedFolders.has(folder.replace(/\\/g, "/")) ||
      (!remote && pathExists(folder))
    );
  });

  const worktreePath = join(repoDir, branch);
  await repo.addWorktree(worktreePath, branch);

  const subPath = subPathInRepo(parent.rootPath, repo.topLevel);
  const taskRoot = subPath === "" ? worktreePath : join(worktreePath, ...subPath.split("/"));
  const location: WorkspaceLocation =
    parent.location.kind === "local"
      ? { kind: "local", rootPath: taskRoot }
      : { ...parent.location, remotePath: taskRoot };
  return deps.manager.create({
    location,
    name: name.trim(),
    task: { parentId, branch, worktreePath },
  });
}

/**
 * Removes a task: its workspace (terminals and agent first, so nothing holds
 * the folder open), then its worktree, then its branch if asked.
 */
export async function removeTask(
  deps: TaskServiceDeps,
  { id, force, deleteBranch }: RemoveTaskArgs,
): Promise<void> {
  const workspace = deps.manager.list().find((candidate) => candidate.id === id);
  const task = workspace?.task;
  if (!task) throw new TaskError("not-found", `no task ${id}`);

  const repo = await deps.getRepository(task.parentId);
  if (repo && !force && (await worktreeHasChanges(repo, task.worktreePath))) {
    throw new TaskError("worktree-dirty", `${task.worktreePath} has changes`);
  }

  deps.manager.remove(id);
  if (!repo) return;

  await removeWorktree(repo, task.worktreePath);
  if (deleteBranch) await repo.deleteBranch(task.branch, true);
}

/** False when the folder is already gone, since there is nothing to lose. */
async function worktreeHasChanges(repo: GitRepository, worktreePath: string): Promise<boolean> {
  try {
    return await repo.worktreeHasChanges(worktreePath);
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

/**
 * Removes the worktree, forced since its changes were checked already. A
 * folder deleted by hand leaves only git's record, which prune drops. On
 * Windows the closed terminals and agent can hold files for a moment, so a
 * failure is retried once.
 */
async function removeWorktree(repo: GitRepository, worktreePath: string): Promise<void> {
  try {
    await repo.removeWorktree(worktreePath, true);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (/is not a working tree/i.test(error.stderr)) {
      await repo.pruneWorktrees();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await repo.removeWorktree(worktreePath, true);
  }
}
