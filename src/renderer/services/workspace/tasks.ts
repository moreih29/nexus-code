/**
 * Tasks: workspaces on git worktrees of another workspace's repository. Main
 * makes and removes the worktree; this side switches to the task and starts
 * its coding agent.
 */

import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";
import { useActiveStore } from "../../state/stores/active";
import { resolvedTaskAgentCommand } from "../../state/stores/terminal";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { openTerminal } from "../terminal/open-terminal";
import { queueStartupInput } from "../terminal/pty-client";
import { quoteShellArgument } from "../terminal/shell-quote";

const log = createLogger("tasks");

/** Why a task operation failed: the IPC error kind and its message. */
export interface TaskFailure {
  readonly kind: string;
  readonly message: string;
}

/** Activates a workspace here and tells main, which connects an SSH one. */
export function activateWorkspace(id: string): void {
  useActiveStore.getState().setActiveWorkspaceId(id);
  void ipcCallResult("workspace", "activate", { id }).then((result) => {
    if (!result.ok) log.warn(`workspace activate failed: ${result.message}`);
  });
}

/**
 * The line a new task's terminal types: the agent command, then the prompt
 * as one argument when there is one. Null when the command is empty.
 */
export function agentCommandLine(
  command: string,
  prompt: string,
  shellPath?: string,
): string | null {
  if (command === "") return null;
  const text = prompt.trim();
  return text === "" ? `${command}\r` : `${command} ${quoteShellArgument(text, shellPath)}\r`;
}

/**
 * Creates a task of `parentId` and switches to it. Its first terminal runs
 * the task agent command with `prompt`.
 */
export async function createTask(
  parentId: string,
  name: string,
  prompt: string,
): Promise<TaskFailure | null> {
  const result = await ipcCallResult("task", "create", { parentId, name });
  if (!result.ok) return { kind: result.kind, message: result.message };

  const store = useWorkspacesStore.getState();
  store.upsert(result.value);
  const task = useWorkspacesStore.getState().workspaces.find((w) => w.id === result.value.id);
  if (!task) return null;

  // A workspace that has a tab gets no terminal from its panel, so this is
  // the task's only one.
  const { tabId } = openTerminal({ workspaceId: task.id, cwd: task.rootPath });
  const command = resolvedTaskAgentCommand();
  if (command !== "") {
    queueStartupInput(
      task.id,
      tabId,
      (shellPath) => agentCommandLine(command, prompt, shellPath) ?? "",
    );
  }
  activateWorkspace(task.id);
  return null;
}

/**
 * Removes a task: its terminals, its worktree and, when asked, its branch.
 * Without `force` it fails with "worktree-dirty" when the worktree has
 * changes, which `force` throws away.
 */
export async function removeTask(
  id: string,
  options: { force: boolean; deleteBranch: boolean },
): Promise<TaskFailure | null> {
  const result = await ipcCallResult("task", "remove", { id, ...options });
  return result.ok ? null : { kind: result.kind, message: result.message };
}
