import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import os from "node:os";
import path from "node:path";

mock.module("electron", () => ({ app: { isPackaged: false } }));

const { GlobalStorage } = await import("../../../../src/main/infra/storage/global-storage");
const { WorkspaceStorage } = await import("../../../../src/main/infra/storage/workspace-storage");
const { StateService } = await import("../../../../src/main/infra/storage/state-service");
const { WorkspaceManager } = await import("../../../../src/main/features/workspace/manager");

function makeManager() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const broadcast = mock((_channel: string, _event: string, _args: unknown) => {});
  const manager = new WorkspaceManager(
    new GlobalStorage(new Database(":memory:")),
    new WorkspaceStorage(
      path.join(os.tmpdir(), `nexus-tasks-${stamp}`),
      () => new Database(":memory:"),
    ),
    new StateService(path.join(os.tmpdir(), `nexus-tasks-state-${stamp}.json`)),
    broadcast,
  );
  return { manager, broadcast };
}

describe("WorkspaceManager — tasks", () => {
  test("a task keeps sidebar position 0 and goes with its parent", () => {
    const { manager, broadcast } = makeManager();
    const parent = manager.create({ rootPath: path.join(os.tmpdir(), "nexus-task-parent") });
    const other = manager.create({ rootPath: path.join(os.tmpdir(), "nexus-task-other") });
    const task = manager.create({
      rootPath: path.join(os.tmpdir(), "nexus-task-wt"),
      name: "fix",
      task: { parentId: parent.id, branch: "fix", worktreePath: "/wt/fix" },
    });
    expect(task.sortOrder).toBe(0);
    expect(task.task?.parentId).toBe(parent.id);

    manager.remove(parent.id);

    expect(manager.list().map((workspace) => workspace.id)).toEqual([other.id]);
    const removed = broadcast.mock.calls
      .filter(([, event]) => event === "removed")
      .map(([, , args]) => (args as { id: string }).id);
    expect(removed).toEqual([task.id, parent.id]);
  });

  test("the worktrees root is ~/.nexus-code/worktrees for a local workspace", () => {
    const { manager } = makeManager();
    const workspace = manager.create({ rootPath: path.join(os.tmpdir(), "nexus-task-root") });
    expect(manager.getWorktreesRoot(workspace.id)).toBe(
      path.join(os.homedir(), ".nexus-code", "worktrees"),
    );
    expect(manager.getWorktreesRoot("missing")).toBeNull();
  });
});
