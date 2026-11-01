/**
 * What the sessions tab does for the user: show a session's terminal, type
 * a line into it or interrupt it, show a worktree's changes, and make or
 * delete a task through the app's own dialogs.
 */

import { useActiveStore } from "@/state/stores/active";
import { useLayoutStore } from "@/state/stores/layout/store";
import { useTaskUIStore } from "@/state/stores/task-ui";
import { useUIStore } from "@/state/stores/ui";
import { actionHandlers } from "../cli/actions";
import { groupOf } from "../cli/placement";
import { activateWorkspace } from "../workspace/tasks";

interface SessionRef {
  readonly workspaceId: string;
  readonly tabId: string;
}

/** Switches to the session's workspace and shows its terminal. */
export function showTerminal({ workspaceId, tabId }: SessionRef): void {
  const groupId = groupOf(workspaceId, tabId);
  if (!groupId) return;
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
  useLayoutStore.getState().setActiveTabInGroup({ workspaceId, groupId, tabId });
}

/** Types `text` into the session's terminal and presses Enter. */
export async function sendLine(session: SessionRef, text: string): Promise<void> {
  await actionHandlers["terminal.input"]({ ...session, text, mode: "paste", enter: true });
}

/** Presses Ctrl-C in the session's terminal. */
export async function interrupt(session: SessionRef): Promise<void> {
  await actionHandlers["terminal.input"]({ ...session, text: "\x03", mode: "keys", enter: false });
}

/** Switches to the worktree with its files panel on the git view. */
export function showChanges(workspaceId: string): void {
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
  const ui = useUIStore.getState();
  ui.setFilesPanelMode(workspaceId, "git");
  ui.setPanelHidden("files", false);
}

export function newTask(rootId: string): void {
  useTaskUIStore.getState().openNewTask(rootId);
}

export function removeTask(taskId: string): void {
  useTaskUIStore.getState().openRemoveTask(taskId);
}
