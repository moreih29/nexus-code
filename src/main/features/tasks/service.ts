import fs from "node:fs";
import path from "node:path";
import type {
  WorkspaceLocation,
  WorkspaceMeta,
  WorkspaceTask,
} from "../../../shared/types/workspace";
import { GitError } from "../git/domain/error";
import type { GitRepository } from "../git/domain/repository";
import type { WorkspaceManager } from "../workspace/manager";
import { repoFolderName, subPathInRepo, taskSlug, uniqueName } from "./naming";

export type TaskErrorKind =
  | "not-found"
  | "not-a-repo"
  | "not-connected"
  | "invalid-name"
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
  readonly getRepository: (workspaceId: string) => Promise<GitRepository | null>;
  readonly localPathExists?: (p: string) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CreateTaskArgs {
  readonly parentId: string;
  readonly name: string;
  readonly createdBy?: WorkspaceTask["createdBy"];
}

export interface RemoveTaskArgs {
  readonly id: string;
  readonly force: boolean;
  readonly deleteBranch: boolean | "merged";
}

export async function createTask(
  deps: TaskServiceDeps,
  { parentId, name, createdBy }: CreateTaskArgs,
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

  const remote = parent.location.kind !== "local";
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
    task: { parentId, branch, worktreePath, ...(createdBy ? { createdBy } : {}) },
  });
}

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

  await deps.manager.remove(id);
  if (!repo) return;

  const checkedOut = deleteBranch
    ? await repo.worktreeBranch(task.worktreePath).catch(() => null)
    : null;
  const wait = deps.sleep ?? sleep;
  await removeWorktree(repo, task.worktreePath, wait);
  if (workspace.location.kind === "local") await removeEmptyFolder(task.worktreePath, wait);
  if (!deleteBranch) return;
  const branch = await taskBranch(repo, task.branch, checkedOut);
  if (branch === null) return;
  if (deleteBranch === true) await repo.deleteBranch(branch, true);
  else await repo.deleteBranch(branch, false).catch(() => {});
}

async function taskBranch(
  repo: GitRepository,
  made: string,
  checkedOut: string | null,
): Promise<string | null> {
  if (await repo.hasBranch(made)) return made;
  if (checkedOut && (await repo.branchRenamedFrom(checkedOut, made))) return checkedOut;
  return null;
}

async function worktreeHasChanges(repo: GitRepository, worktreePath: string): Promise<boolean> {
  try {
    return await repo.worktreeHasChanges(worktreePath);
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

async function removeWorktree(
  repo: GitRepository,
  worktreePath: string,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await repo.removeWorktree(worktreePath, true);
      return;
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      if (/is not a working tree/i.test(error.stderr)) {
        await repo.pruneWorktrees();
        return;
      }
      if (attempt === 2) throw error;
      await wait(500);
    }
  }
}

const EMPTY_FOLDER_ATTEMPTS = 5;
const HELD_FOLDER_MS = 60_000;
const HELD_FOLDER_INTERVAL_MS = 1000;

async function removeEmptyFolder(
  folder: string,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; attempt <= EMPTY_FOLDER_ATTEMPTS; attempt++) {
    if (await removedOrKept(folder)) return;
    await wait(100 * attempt);
  }
  void (async () => {
    for (let waited = 0; waited < HELD_FOLDER_MS; waited += HELD_FOLDER_INTERVAL_MS) {
      await wait(HELD_FOLDER_INTERVAL_MS);
      if (await removedOrKept(folder)) return;
    }
  })();
}

async function removedOrKept(folder: string): Promise<boolean> {
  try {
    await fs.promises.rmdir(folder);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTEMPTY";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
