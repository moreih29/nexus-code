import { expect, test } from "bun:test";
import { getActiveTabContext } from "../../../../../src/renderer/commands/context";
import { moveTabToZone } from "../../../../../src/renderer/state/operations/dnd";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

test("moving a tab to another group routes keyboard commands to its destination", () => {
  const workspaceId = "3d8d931c-a10e-4323-aec3-ea45270e9366";
  const layout = useLayoutStore.getState();
  const tabs = useTabsStore.getState();
  const { activeWorkspaceId } = useActiveStore.getState();

  try {
    layout.ensureLayout(workspaceId);
    const left = useLayoutStore.getState().byWorkspace[workspaceId]!.activeGroupId;
    const right = layout.splitGroup(workspaceId, left, "horizontal", "after");
    function addTab(filePath: string, group: string): string {
      const tab = tabs.createTab(workspaceId, { type: "editor", props: { workspaceId, filePath } });
      layout.attachTab(workspaceId, group, tab.id);
      return tab.id;
    }
    addTab("/repo/stays.txt", left);
    const moved = addTab("/repo/moved.txt", left);
    addTab("/repo/right.txt", right);
    layout.setActiveGroup(workspaceId, left);
    useActiveStore.setState({ activeWorkspaceId: workspaceId });

    expect(getActiveTabContext()?.leaf.id).toBe(left);
    expect(moveTabToZone(workspaceId, moved, { groupId: right, zone: "center" })).toEqual({
      kind: "moved",
      groupId: right,
      tabId: moved,
    });
    expect(getActiveTabContext()?.leaf.id).toBe(right);
    expect(getActiveTabContext()?.tabId).toBe(moved);
  } finally {
    useActiveStore.setState({ activeWorkspaceId });
    layout.closeAllForWorkspace(workspaceId);
    tabs.closeAllForWorkspace(workspaceId);
  }
});
