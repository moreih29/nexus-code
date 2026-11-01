import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { GlobalStorage } from "../../../../src/main/infra/storage/global-storage";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

function meta(overrides: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
  const rootPath = overrides.rootPath ?? `/work/${randomUUID()}`;
  return {
    id: randomUUID(),
    name: "w",
    location: { kind: "local", rootPath },
    rootPath,
    colorTone: "default",
    pinned: false,
    tabs: [],
    sortOrder: 1024,
    pinnedSortOrder: 0,
    ...overrides,
  };
}

describe("GlobalStorage — tasks", () => {
  it("reads back a task's parent, branch and worktree, and none for others", () => {
    const storage = new GlobalStorage(new Database(":memory:"));
    const parent = meta();
    const task = meta({
      sortOrder: 0,
      task: { parentId: parent.id, branch: "fix", worktreePath: "/wt/repo-abc123/fix" },
    });
    storage.addWorkspace(parent);
    storage.addWorkspace(task);
    storage.updateWorkspace(task.id, { name: "renamed" });

    const byId = new Map(storage.listWorkspaces().map((w) => [w.id, w]));
    expect(byId.get(parent.id)?.task).toBeUndefined();
    expect(byId.get(task.id)?.task).toEqual(task.task);
    expect(byId.get(task.id)?.name).toBe("renamed");
  });

  it("leaves tasks out of the sidebar order", () => {
    const storage = new GlobalStorage(new Database(":memory:"));
    const first = meta({ sortOrder: 1024 });
    const second = meta({ sortOrder: 2048 });
    // A task with a position between the two must not narrow their gap or
    // shift the tail.
    const task = meta({
      sortOrder: 1500,
      task: { parentId: first.id, branch: "t", worktreePath: "/wt/t" },
    });
    for (const workspace of [first, second, task]) storage.addWorkspace(workspace);

    expect(storage.nextTailSortOrder("unpinned")).toBe(3072);
    expect(storage.computeInsertPosition({ groupKind: "unpinned", afterId: first.id })).toEqual({
      position: 1536,
    });
    const rebalanced = storage.rebalanceGroup("unpinned").map((row) => row.id);
    expect(rebalanced).toEqual([first.id, second.id]);
  });
});
