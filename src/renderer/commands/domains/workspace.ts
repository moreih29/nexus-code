import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { goToNextWaiting } from "../../services/agent-sessions/use-inbox";
import { activateWorkspace } from "../../state/operations/workspace-selection";
import { useActiveStore } from "../../state/stores/active";
import { useAddWorkspaceUIStore } from "../../state/stores/add-workspace-ui";
import { usePeerWorkspaceStore } from "../../state/stores/peer-workspace";
import { useTaskUIStore } from "../../state/stores/task-ui";
import {
  rootWorkspaceId,
  useWorkspacesStore,
  visibleWorkspaces,
} from "../../state/stores/workspaces";

/**
 * Cycle the active workspace by `delta` slots within the sidebar's
 * sorted order (pinned rows above unpinned, preserving the store's
 * existing `compareSortKey` order). Wraps at both ends so ⌘⌃↑ from
 * the first workspace lands on the last, and vice-versa.
 *
 * If the selection is missing from the list, start at the natural end
 * for the direction. A task counts as its parent's row.
 */
export function cycleActiveWorkspace(delta: 1 | -1): void {
  if (usePeerWorkspaceStore.getState().active) return;
  const all = useWorkspacesStore.getState().workspaces;
  const workspaces = visibleWorkspaces(all);
  if (workspaces.length === 0) return;
  const activeId = useActiveStore.getState().activeWorkspaceId;
  const rowId = activeId !== null ? rootWorkspaceId(all, activeId) : null;
  const currentIndex = rowId !== null ? workspaces.findIndex((w) => w.id === rowId) : -1;

  let nextIndex: number;
  if (currentIndex < 0) {
    // Active not in the list — start at the natural end based on direction.
    nextIndex = delta === 1 ? 0 : workspaces.length - 1;
  } else {
    nextIndex = (currentIndex + delta + workspaces.length) % workspaces.length;
  }

  const next = workspaces[nextIndex].id;
  if (next !== activeId) activateWorkspace(next, "preserve");
}

export function registerWorkspaceCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.workspaceFocusPrev, () => cycleActiveWorkspace(-1)),
    registerCommand(COMMANDS.workspaceFocusNext, () => cycleActiveWorkspace(1)),
    registerCommand(COMMANDS.workspaceAdd, () => {
      useAddWorkspaceUIStore.getState().openAddWorkspace();
    }),
    registerCommand(COMMANDS.taskNew, () => {
      const activeId = useActiveStore.getState().activeWorkspaceId;
      if (activeId === null) return;
      const parentId = rootWorkspaceId(useWorkspacesStore.getState().workspaces, activeId);
      useTaskUIStore.getState().openNewTask(parentId);
    }),
    registerCommand(COMMANDS.sessionNextWaiting, goToNextWaiting),
  ];
}
