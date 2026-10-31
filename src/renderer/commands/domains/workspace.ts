import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { useActiveStore } from "../../state/stores/active";
import { useAddWorkspaceUIStore } from "../../state/stores/add-workspace-ui";
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
 * No-op when there is at most one workspace, or when the active id is
 * absent from the list (e.g. mid-removal); we fall back to the first
 * row in that case so the shortcut still feels responsive. A task counts
 * as its parent's row, so the step starts there.
 */
export function cycleActiveWorkspace(delta: 1 | -1): void {
  const all = useWorkspacesStore.getState().workspaces;
  const workspaces = visibleWorkspaces(all);
  if (workspaces.length === 0) return;
  if (workspaces.length === 1) {
    // Still set it explicitly so a fresh boot with no active id picks
    // up the only available workspace on the very first keystroke.
    useActiveStore.getState().setActiveWorkspaceId(workspaces[0].id);
    return;
  }

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

  useActiveStore.getState().setActiveWorkspaceId(workspaces[nextIndex].id);
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
  ];
}
