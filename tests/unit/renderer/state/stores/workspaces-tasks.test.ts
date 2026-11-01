import { beforeEach, describe, expect, test } from "bun:test";
import { cycleActiveWorkspace } from "../../../../../src/renderer/commands/domains/workspace";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";
import {
  rootWorkspaceId,
  tasksOf,
  useWorkspacesStore,
  visibleWorkspaces,
} from "../../../../../src/renderer/state/stores/workspaces";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const A_TASK = "00000000-0000-4000-8000-0000000000a1";
const B_TASK = "00000000-0000-4000-8000-0000000000b1";

function workspace(id: string, parentId?: string): WorkspaceMeta {
  return {
    id,
    name: id,
    location: { kind: "local", rootPath: `/tmp/${id}` },
    rootPath: `/tmp/${id}`,
    colorTone: "default",
    pinned: false,
    tabs: [],
    sortOrder: 0,
    pinnedSortOrder: 0,
    ...(parentId ? { task: { parentId, branch: id, worktreePath: `/tmp/${id}` } } : {}),
  };
}

// Tasks sit anywhere in the list; main sorts them in with sort order 0.
const LIST = [workspace(A_TASK, A), workspace(A), workspace(B), workspace(B_TASK, B)];

describe("task helpers", () => {
  test("the sidebar lists everything but tasks", () => {
    expect(visibleWorkspaces(LIST).map((w) => w.id)).toEqual([A, B]);
  });

  test("tasksOf lists one workspace's tasks", () => {
    expect(tasksOf(LIST, A).map((w) => w.id)).toEqual([A_TASK]);
    expect(tasksOf(LIST, A_TASK)).toEqual([]);
  });

  test("rootWorkspaceId maps a task to its parent", () => {
    expect(rootWorkspaceId(LIST, A_TASK)).toBe(A);
    expect(rootWorkspaceId(LIST, B)).toBe(B);
    expect(rootWorkspaceId(LIST, "gone")).toBe("gone");
  });
});

describe("cycleActiveWorkspace with tasks", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({ workspaces: LIST });
  });

  test("steps over tasks", () => {
    useActiveStore.getState().setActiveWorkspaceId(A);
    cycleActiveWorkspace(1);
    expect(useActiveStore.getState().activeWorkspaceId).toBe(B);
    cycleActiveWorkspace(1);
    expect(useActiveStore.getState().activeWorkspaceId).toBe(A);
  });

  test("steps from a task's parent row", () => {
    useActiveStore.getState().setActiveWorkspaceId(B_TASK);
    cycleActiveWorkspace(-1);
    expect(useActiveStore.getState().activeWorkspaceId).toBe(A);
  });
});
