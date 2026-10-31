import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTask,
  removeTask,
  TaskError,
  type TaskServiceDeps,
} from "../../../../src/main/features/tasks/service";
import type { WorkspaceCreateOptions } from "../../../../src/main/features/workspace/manager";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";
import { newLocalGitRepository } from "../git/helpers/local-semantic-executor";

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
}

let tmp: string;
let repoDir: string;
let worktreesRoot: string;

beforeAll(() => {
  // realpath: git reports /private/var on macOS where tmpdir says /var.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tasks-")));
  repoDir = path.join(tmp, "repo");
  worktreesRoot = path.join(tmp, "worktrees");
  fs.mkdirSync(path.join(repoDir, "packages", "app"), { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoDir, "packages", "app", "a.txt"), "a\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-q", "-m", "init");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A manager holding metas in memory, and the parent workspace in it. */
function setup(parentRoot = repoDir) {
  const workspaces: WorkspaceMeta[] = [];
  const parent: WorkspaceMeta = {
    id: randomUUID(),
    name: "repo",
    location: { kind: "local", rootPath: parentRoot },
    rootPath: parentRoot,
    colorTone: "default",
    pinned: false,
    tabs: [],
    sortOrder: 1024,
    pinnedSortOrder: 0,
  };
  workspaces.push(parent);
  const removed: string[] = [];
  const deps: TaskServiceDeps = {
    manager: {
      list: () => [...workspaces],
      create: (opts: WorkspaceCreateOptions) => {
        if (!("location" in opts)) throw new Error("expected a location");
        const root = opts.location.kind === "local" ? opts.location.rootPath : "";
        const meta: WorkspaceMeta = {
          ...parent,
          id: randomUUID(),
          name: opts.name ?? "",
          location: opts.location,
          rootPath: root,
          sortOrder: 0,
          task: opts.task,
        };
        workspaces.push(meta);
        return meta;
      },
      remove: (id: string) => {
        removed.push(id);
        workspaces.splice(
          workspaces.findIndex((workspace) => workspace.id === id),
          1,
        );
      },
      getWorktreesRoot: () => worktreesRoot,
    },
    getRepository: async (workspaceId) =>
      workspaceId === parent.id
        ? newLocalGitRepository(workspaceId, repoDir, path.join(repoDir, ".git"), "git")
        : null,
  };
  return { deps, parent, workspaces, removed };
}

function localBranches(): string[] {
  return git(repoDir, "branch", "--format=%(refname:short)").trim().split("\n");
}

describe("createTask", () => {
  it("adds a worktree on a new branch and a task workspace on it", async () => {
    const { deps, parent } = setup();
    const task = await createTask(deps, { parentId: parent.id, name: "Fix login" });

    expect(task.task?.parentId).toBe(parent.id);
    expect(task.task?.branch).toBe("fix-login");
    expect(path.dirname(path.dirname(task.task?.worktreePath ?? ""))).toBe(worktreesRoot);
    expect(task.rootPath).toBe(task.task?.worktreePath ?? "");
    expect(task.name).toBe("Fix login");
    expect(fs.existsSync(path.join(task.rootPath, "packages", "app", "a.txt"))).toBe(true);
    expect(git(task.rootPath, "branch", "--show-current").trim()).toBe("fix-login");
  });

  it("picks the next free name when the branch exists", async () => {
    const { deps, parent } = setup();
    git(repoDir, "branch", "taken");
    const task = await createTask(deps, { parentId: parent.id, name: "taken" });
    expect(task.task?.branch).toBe("taken-2");
    expect(path.basename(task.task?.worktreePath ?? "")).toBe("taken-2");
  });

  it("opens the parent's subfolder in the worktree", async () => {
    const { deps, parent } = setup(path.join(repoDir, "packages", "app"));
    const task = await createTask(deps, { parentId: parent.id, name: "sub" });
    expect(task.rootPath).toBe(path.join(task.task?.worktreePath ?? "", "packages", "app"));
  });

  it("refuses a name with nothing usable and a workspace outside git", async () => {
    const { deps, parent } = setup();
    await expect(createTask(deps, { parentId: parent.id, name: "!!!" })).rejects.toMatchObject({
      kind: "invalid-name",
    });
    const outside = { ...deps, getRepository: async () => null };
    const error = await createTask(outside, { parentId: parent.id, name: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(TaskError);
    expect(error.kind).toBe("not-a-repo");
  });
});

describe("removeTask", () => {
  it("removes a clean worktree and keeps or deletes the branch as asked", async () => {
    const { deps, parent, removed } = setup();
    const kept = await createTask(deps, { parentId: parent.id, name: "keep branch" });
    const dropped = await createTask(deps, { parentId: parent.id, name: "drop branch" });

    await removeTask(deps, { id: kept.id, force: false, deleteBranch: false });
    await removeTask(deps, { id: dropped.id, force: false, deleteBranch: true });

    expect(removed).toEqual([kept.id, dropped.id]);
    expect(fs.existsSync(kept.task?.worktreePath ?? "")).toBe(false);
    expect(fs.existsSync(dropped.task?.worktreePath ?? "")).toBe(false);
    expect(localBranches()).toContain("keep-branch");
    expect(localBranches()).not.toContain("drop-branch");
  });

  it("refuses a worktree with changes unless forced, removing nothing", async () => {
    const { deps, parent, removed } = setup();
    const task = await createTask(deps, { parentId: parent.id, name: "dirty" });
    fs.writeFileSync(path.join(task.rootPath, "new.txt"), "x\n");

    await expect(
      removeTask(deps, { id: task.id, force: false, deleteBranch: false }),
    ).rejects.toMatchObject({ kind: "worktree-dirty" });
    expect(removed).toEqual([]);
    expect(fs.existsSync(task.rootPath)).toBe(true);

    await removeTask(deps, { id: task.id, force: true, deleteBranch: false });
    expect(fs.existsSync(task.rootPath)).toBe(false);
  });

  it("drops git's record when the folder was deleted by hand", async () => {
    const { deps, parent } = setup();
    const task = await createTask(deps, { parentId: parent.id, name: "gone" });
    fs.rmSync(task.task?.worktreePath ?? "", { recursive: true, force: true });

    await removeTask(deps, { id: task.id, force: false, deleteBranch: false });
    expect(git(repoDir, "worktree", "list")).not.toContain("gone");
  });
});
