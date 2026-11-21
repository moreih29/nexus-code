import { expect, test } from "bun:test";
import { chatHandlers } from "../../../../../src/renderer/services/cli/chat-actions";
import { useAgentInstructionsStore } from "../../../../../src/renderer/state/stores/agent-instructions";
import { useAgentProfilesStore } from "../../../../../src/renderer/state/stores/agent-profiles";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import { WorkspaceMetaSchema } from "../../../../../src/shared/types/workspace";

test("chat instructions expose the tab's editable text and ordered composer layers", async () => {
  const defaults = { pinned: false, tabs: [] };
  const parent = WorkspaceMetaSchema.parse({
    ...defaults,
    id: "11111111-1111-4111-8111-111111111111",
    name: "Parent",
    rootPath: "/repo",
  });
  const task = WorkspaceMetaSchema.parse({
    ...defaults,
    id: "22222222-2222-4222-8222-222222222222",
    name: "Task",
    rootPath: "/worktree",
    task: { parentId: parent.id, branch: "task", worktreePath: "/worktree" },
  });
  const { workspaces } = useWorkspacesStore.getState();
  const { config } = useAgentInstructionsStore.getState();
  const profiles = useAgentProfilesStore.getState().config;
  const { byWorkspace, createTab } = useTabsStore.getState();
  try {
    useWorkspacesStore.setState({ workspaces: [parent, task] });
    useAgentProfilesStore.getState().hydrate({
      profiles: [{ id: "work", name: "Work", agent: "codex", color: "cyan", dir: "/codex-work" }],
      rules: [],
      defaults: {},
    });
    useAgentInstructionsStore.setState({
      config: {
        all: "Shared rules",
        claude: "Claude rules",
        profiles: { work: "Profile rules", "codex-default": "Default rules" },
        workspaces: { [parent.id]: "Parent rules", [task.id]: "Legacy rules" },
      },
    });
    const tab = createTab(task.id, {
      type: "codex",
      props: { cwd: task.rootPath, profileId: "work" },
    });
    const target = { workspaceId: task.id, tabId: tab.id };
    const instructions = chatHandlers["chat.instructions"];
    const layers = [
      { scope: { kind: "all" }, title: "All agents", text: "Shared rules" },
      { scope: { kind: "agent", agent: "codex" }, title: "Codex", text: "" },
      { scope: { kind: "profile", id: "work" }, title: "Profile: Work", text: "Profile rules" },
      {
        scope: { kind: "workspace", id: parent.id },
        title: "Workspace: Parent",
        text: "Parent rules",
      },
    ];

    const initial = await instructions(target);
    expect(initial).toMatchObject({ session: "", layers });
    expect(initial.instructions).toEndWith(
      "## All agents\nShared rules\n\n## Profile: Work\nProfile rules\n\n## Workspace: Parent\nParent rules",
    );
    const text = "\nSession rules  ";
    const changed = await instructions({ ...target, text });
    expect(changed).toEqual({
      session: text,
      layers,
      instructions: `${initial.instructions}\n\n## This session\nSession rules`,
    });
    expect(await instructions(target)).toEqual(changed);
    expect(await instructions({ ...target, text: " \n " })).toEqual(initial);
  } finally {
    useTabsStore.setState({ byWorkspace });
    useWorkspacesStore.setState({ workspaces });
    useAgentInstructionsStore.setState({ config });
    useAgentProfilesStore.getState().hydrate(profiles);
  }
});
