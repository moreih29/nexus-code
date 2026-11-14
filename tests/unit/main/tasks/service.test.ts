import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitError } from "../../../../src/main/features/git/domain/error";
import {
  createTask,
  removeTask,
  type TaskServiceDeps,
} from "../../../../src/main/features/tasks/service";
import type { WorkspaceCreateOptions } from "../../../../src/main/features/workspace/manager";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";
import { newLocalGitRepository } from "../git/helpers/local-semantic-executor";

// An empty global config keeps the developer's out. Not os.devNull: git for
// Windows cannot open \\.\nul.
const emptyConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gitconfig-")), "config");
fs.writeFileSync(emptyConfig, "");

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: emptyConfig,
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
  fs.rmSync(path.dirname(emptyConfig), { recursive: true, force: true });
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
    // The removal's tries in the same order, a hundred times faster.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms / 100)),
  };
  return { deps, parent, workspaces, removed };
}

function localBranches(): string[] {
  return git(repoDir, "branch", "--format=%(refname:short)").trim().split("\n");
}

describe("createTask", () => {
  it("picks the next free name when the branch exists", async () => {
    const { deps, parent } = setup();
    git(repoDir, "branch", "taken");
    const task = await createTask(deps, { parentId: parent.id, name: "taken" });
    expect(task.task?.branch).toBe("taken-2");
    expect(path.basename(task.task?.worktreePath ?? "")).toBe("taken-2");
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

  it("deletes the branch renamed in its worktree, and no other branch checked out there", async () => {
    const { deps, parent } = setup();
    const renamed = await createTask(deps, { parentId: parent.id, name: "notes" });
    git(renamed.rootPath, "branch", "-m", "notes", "feat/notes");
    const switched = await createTask(deps, { parentId: parent.id, name: "switched" });
    git(switched.rootPath, "switch", "-q", "-c", "someone-elses");
    git(switched.rootPath, "branch", "-D", "switched");

    await removeTask(deps, { id: renamed.id, force: false, deleteBranch: true });
    await removeTask(deps, { id: switched.id, force: false, deleteBranch: true });

    expect(localBranches()).not.toContain("feat/notes");
    expect(localBranches()).toContain("someone-elses");
  });

  it('deletes a merged branch for "merged", and keeps one with commits of its own', async () => {
    const { deps, parent } = setup();
    const merged = await createTask(deps, { parentId: parent.id, name: "nothing new" });
    const ahead = await createTask(deps, { parentId: parent.id, name: "one commit" });
    fs.writeFileSync(path.join(ahead.rootPath, "b.txt"), "b\n");
    git(ahead.rootPath, "add", ".");
    git(ahead.rootPath, "commit", "-q", "-m", "b");

    await removeTask(deps, { id: merged.id, force: false, deleteBranch: "merged" });
    await removeTask(deps, { id: ahead.id, force: false, deleteBranch: "merged" });

    expect(fs.existsSync(ahead.task?.worktreePath ?? "")).toBe(false);
    expect(localBranches()).not.toContain("nothing-new");
    expect(localBranches()).toContain("one-commit");
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

  it("finishes when a failed attempt dropped git's record and left the folder", async () => {
    const { deps, parent } = setup();
    const task = await createTask(deps, { parentId: parent.id, name: "held" });
    const worktreePath = task.task?.worktreePath ?? "";
    // As on Windows when a closing program still holds the folder: git
    // deletes the files and its record, fails on the folder, and says so.
    let failed = false;
    const held: TaskServiceDeps = {
      ...deps,
      getRepository: async (workspaceId) => {
        const repo = await deps.getRepository(workspaceId);
        if (!repo) return null;
        const removeWorktree = repo.removeWorktree.bind(repo);
        repo.removeWorktree = async (target, force) => {
          await removeWorktree(target, force);
          if (failed) return;
          failed = true;
          fs.mkdirSync(target);
          throw new GitError("unknown", "failed", {
            stderr: `error: failed to delete '${target}'`,
          });
        };
        return repo;
      },
    };

    await removeTask(held, { id: task.id, force: true, deleteBranch: true });
    expect(failed).toBe(true);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(localBranches()).not.toContain("held");
  });

  it("deletes the folder after it returns when its holder waits on the removal", async () => {
    const { deps, parent } = setup();
    const task = await createTask(deps, { parentId: parent.id, name: "waiting" });
    const worktreePath = task.task?.worktreePath ?? "";
    // As on Windows when Claude Code's WorktreeRemove hook asks for the
    // removal: the claude waiting on it has the folder for its cwd.
    let holding = true;
    const held: TaskServiceDeps = {
      ...deps,
      getRepository: async (workspaceId) => {
        const repo = await deps.getRepository(workspaceId);
        if (!repo) return null;
        const removeWorktree = repo.removeWorktree.bind(repo);
        repo.removeWorktree = async (target, force) => {
          await removeWorktree(target, force);
          fs.mkdirSync(target);
          throw new GitError("unknown", "failed", {
            stderr: `error: failed to delete '${target}'`,
          });
        };
        return repo;
      },
    };
    const rmdir = fs.promises.rmdir;
    const spy = spyOn(fs.promises, "rmdir").mockImplementation(async (target, options) => {
      if (holding && target === worktreePath) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return rmdir(target, options);
    });
    try {
      await removeTask(held, { id: task.id, force: true, deleteBranch: true });
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(localBranches()).not.toContain("waiting");

      holding = false;
      const deadline = Date.now() + 3000;
      while (fs.existsSync(worktreePath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(fs.existsSync(worktreePath)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 10_000);
});
