import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentInstructionsPanel } from "../../../../../src/renderer/components/settings/panels/agent-instructions-panel";
import { useAgentInstructionsStore } from "../../../../../src/renderer/state/stores/agent-instructions";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import { WorkspaceMetaSchema } from "../../../../../src/shared/types/workspace";

test("task workspaces are omitted from the instructions editor and its preview", () => {
  const defaults = { pinned: false, tabs: [] };
  const parent = WorkspaceMetaSchema.parse({
    ...defaults,
    id: "11111111-1111-4111-8111-111111111111",
    name: "Parent workspace",
    rootPath: "/repo",
  });
  const task = WorkspaceMetaSchema.parse({
    ...defaults,
    id: "22222222-2222-4222-8222-222222222222",
    name: "Task workspace",
    rootPath: "/worktree",
    task: { parentId: parent.id, branch: "task", worktreePath: "/worktree" },
  });
  const workspaceState = { ...useWorkspacesStore.getState(), workspaces: [task, parent] };
  const instructionsState = {
    ...useAgentInstructionsStore.getState(),
    config: { workspaces: { [parent.id]: "Parent rules", [task.id]: "Legacy rules" } },
  };
  mock.module("../../../../../src/renderer/state/stores/workspaces", () => ({
    useWorkspacesStore: (select: (state: typeof workspaceState) => unknown) =>
      select(workspaceState),
  }));
  mock.module("../../../../../src/renderer/state/stores/agent-instructions", () => ({
    useAgentInstructionsStore: (select: (state: typeof instructionsState) => unknown) =>
      select(instructionsState),
  }));

  const html = renderToStaticMarkup(<AgentInstructionsPanel />);
  expect(html).toContain('title="Parent workspace"');
  expect(html).not.toContain("Task workspace");
  expect(html).toContain("## Workspace: Parent workspace\nParent rules");
  expect(html).not.toContain("Legacy rules");
  const summary = html.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1] ?? "";
  expect(summary.indexOf("Combined instructions")).toBeGreaterThanOrEqual(0);
  expect(summary.indexOf("lucide-chevron-down")).toBeGreaterThan(
    summary.indexOf("Combined instructions"),
  );
  expect(summary).not.toContain("lucide-chevron-right");
});
