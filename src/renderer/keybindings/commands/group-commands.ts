/**
 * Group-domain commands: split right / down, close, focus left / right / up / down.
 */

import { COMMANDS } from "../../../shared/commands";
import { registerCommand } from "../../commands/registry";
import { Grid } from "../../engine/split";
import { openOrRevealEditor } from "../../services/editor";
import { openTerminal } from "../../services/terminal";
import { closeGroup } from "../../state/operations";
import { useActiveStore } from "../../state/stores/active";
import { useLayoutStore } from "../../state/stores/layout";
import { useTabsStore } from "../../state/stores/tabs";

function splitActiveGroup(orientation: "horizontal" | "vertical"): void {
  const wsId = useActiveStore.getState().activeWorkspaceId;
  if (!wsId) return;
  const layout = useLayoutStore.getState().byWorkspace[wsId];
  if (!layout) return;
  const activeLeaf = Grid.findLeaf(layout.root, layout.activeGroupId);
  if (!activeLeaf?.activeTabId) return;
  const tab = useTabsStore.getState().byWorkspace[wsId]?.[activeLeaf.activeTabId];
  if (!tab) return;

  if (tab.type === "editor") {
    openOrRevealEditor(tab.props, {
      newSplit: { orientation, side: "after" },
    });
    return;
  }
  if (tab.type === "terminal") {
    openTerminal(
      { workspaceId: wsId, cwd: tab.props.cwd },
      { groupId: activeLeaf.id, newSplit: { orientation, side: "after" } },
    );
  }
}

function moveFocus(direction: "left" | "right" | "up" | "down"): void {
  const wsId = useActiveStore.getState().activeWorkspaceId;
  if (!wsId) return;
  const layout = useLayoutStore.getState().byWorkspace[wsId];
  if (!layout) return;
  const leaves = Grid.allLeaves(layout.root);
  if (leaves.length <= 1) return;
  const currentIdx = leaves.findIndex((l) => l.id === layout.activeGroupId);
  if (currentIdx === -1) return;
  const nextIdx =
    direction === "left" || direction === "up"
      ? currentIdx > 0
        ? currentIdx - 1
        : leaves.length - 1
      : currentIdx < leaves.length - 1
        ? currentIdx + 1
        : 0;
  const nextLeaf = leaves[nextIdx];
  if (nextLeaf) {
    useLayoutStore.getState().setActiveGroup(wsId, nextLeaf.id);
  }
}

export function registerGroupCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.groupSplitRight, () => splitActiveGroup("horizontal")),
    registerCommand(COMMANDS.groupSplitDown, () => splitActiveGroup("vertical")),
    registerCommand(COMMANDS.groupClose, () => {
      const wsId = useActiveStore.getState().activeWorkspaceId;
      if (!wsId) return;
      const layout = useLayoutStore.getState().byWorkspace[wsId];
      if (!layout) return;
      closeGroup(wsId, layout.activeGroupId);
    }),
    registerCommand(COMMANDS.groupFocusLeft, () => moveFocus("left")),
    registerCommand(COMMANDS.groupFocusRight, () => moveFocus("right")),
    registerCommand(COMMANDS.groupFocusUp, () => moveFocus("up")),
    registerCommand(COMMANDS.groupFocusDown, () => moveFocus("down")),
  ];
}
