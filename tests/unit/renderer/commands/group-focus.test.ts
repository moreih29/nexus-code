import { expect, test } from "bun:test";
import { registerGroupCommands } from "../../../../src/renderer/commands/domains/group";
import { executeCommand } from "../../../../src/renderer/commands/registry";
import { useActiveStore } from "../../../../src/renderer/state/stores/active";
import { useLayoutStore } from "../../../../src/renderer/state/stores/layout";
import { COMMANDS } from "../../../../src/shared/keybindings/commands";

test("group focus follows the requested direction in nested splits", () => {
  const workspaceId = "871e3657-3441-49f8-9ff0-0673d24eb9d4";
  const { activeWorkspaceId } = useActiveStore.getState();
  const store = useLayoutStore.getState();
  const unregister = registerGroupCommands();

  try {
    store.ensureLayout(workspaceId);
    const activeGroup = () => useLayoutStore.getState().byWorkspace[workspaceId]?.activeGroupId;
    const topLeft = activeGroup()!;
    const right = store.splitGroup(workspaceId, topLeft, "horizontal", "after");
    const bottomLeft = store.splitGroup(workspaceId, topLeft, "vertical", "after");
    useActiveStore.setState({ activeWorkspaceId: workspaceId });
    store.setActiveGroup(workspaceId, topLeft);

    executeCommand(COMMANDS.groupFocusRight);
    expect(activeGroup()).toBe(right);
    executeCommand(COMMANDS.groupFocusRight);
    expect(activeGroup()).toBe(right);

    store.setActiveGroup(workspaceId, topLeft);
    executeCommand(COMMANDS.groupFocusDown);
    expect(activeGroup()).toBe(bottomLeft);
    executeCommand(COMMANDS.groupFocusUp);
    expect(activeGroup()).toBe(topLeft);
  } finally {
    for (const dispose of unregister) dispose();
    useActiveStore.setState({ activeWorkspaceId });
    store.closeAllForWorkspace(workspaceId);
  }
});
