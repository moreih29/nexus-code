/**
 * Tasks: workspaces on git worktrees of another workspace's repository. Main
 * makes and removes the worktree; this side switches to the task and starts
 * its coding agent, in a Claude or Codex tab or a terminal.
 */

import type { RelaySender, TerminalOpener } from "../../../shared/chat/relay";
import type { ChatAgent, TaskAgent } from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta, WorkspaceTask } from "../../../shared/types/workspace";
import { ipcCallResult } from "../../ipc/client";
import { activateWorkspace } from "../../state/operations/workspace-selection";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { openAgentTab } from "../chat/agent-tab";
import { openTerminal } from "../terminal/open-terminal";
import { queueStartupInput } from "../terminal/pty-client";
import { quoteShellArgument } from "../terminal/shell-quote";

/** Why a task operation failed: the IPC error kind and its message. */
export interface TaskFailure {
  readonly kind: string;
  readonly message: string;
}

/**
 * The line a terminal types to start an agent: the command, then the prompt
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
 * What a new task starts with: a Claude or Codex tab that takes the prompt
 * as its first message, or a terminal that runs a command with the prompt
 * as its last argument ("" for a plain shell).
 */
export type TaskStart = { readonly agent: ChatAgent } | { readonly command: string };

/** What a task agent choice starts: its tab, or a plain shell for "terminal". */
export function taskStartOf(agent: TaskAgent): TaskStart {
  return agent === "terminal" ? { command: "" } : { agent };
}

/**
 * A task just made: its first tab, and what runs there: the agent of a
 * Claude or Codex tab, or the command of a terminal. A plain shell ("")
 * has no tab yet: the task's panel opens one when it is first shown, as
 * for any workspace without tabs.
 */
export interface StartedTask {
  readonly task: WorkspaceMeta;
  readonly tabId: string | null;
  readonly start: TaskStart;
}

/**
 * Creates a task of `parentId` without switching to it, with one tab: an
 * agent's tab whose program starts now and is sent `prompt`, or a terminal
 * that runs the command with `prompt` once it starts, which is when the
 * task's panel is mounted. A plain shell gets no tab here: the panel opens
 * one when the task is first shown, so a task made behind the user's view
 * runs nothing until then. `createdBy` is the terminal whose agent asked
 * for it, if one did; `from`, who sent the prompt then, as the agent's tab
 * shows it.
 */
export async function startTask(
  parentId: string,
  name: string,
  prompt: string,
  start: TaskStart,
  createdBy?: WorkspaceTask["createdBy"],
  from?: RelaySender,
  openedBy?: TerminalOpener,
): Promise<StartedTask | TaskFailure> {
  const result = await ipcCallResult("task", "create", {
    parentId,
    name,
    ...(createdBy ? { createdBy } : {}),
  });
  if (!result.ok) return { kind: result.kind, message: result.message };

  useWorkspacesStore.getState().upsert(result.value);
  const task =
    useWorkspacesStore.getState().workspaces.find((w) => w.id === result.value.id) ?? result.value;

  // A workspace that has a tab gets no terminal from its panel, so this tab
  // is the task's only one.
  if ("agent" in start) {
    const tabId = openAgentTab(task.id, start.agent, task.rootPath, prompt, undefined, from);
    return { task, tabId, start };
  }
  const command = start.command.trim();
  if (command === "") return { task, tabId: null, start: { command } };
  const { tabId } = openTerminal({ workspaceId: task.id, cwd: task.rootPath, openedBy });
  queueStartupInput(
    task.id,
    tabId,
    (shellPath) => agentCommandLine(command, prompt, shellPath) ?? "",
  );
  return { task, tabId, start: { command } };
}

/**
 * Creates a task of `parentId` and switches to it, with `agent`'s tab sent
 * `prompt`, or a plain terminal, which its panel opens as it is shown.
 */
export async function createTask(
  parentId: string,
  name: string,
  prompt: string,
  agent: TaskAgent,
): Promise<TaskFailure | null> {
  const started = await startTask(parentId, name, prompt, taskStartOf(agent));
  if (!("task" in started)) return started;
  activateWorkspace(started.task.id);
  return null;
}

/**
 * Removes a task: its terminals, its worktree and, when asked, its branch
 * ("merged": only if git finds it merged). Without `force` it fails with
 * "worktree-dirty" when the worktree has changes, which `force` throws away.
 */
export async function removeTask(
  id: string,
  options: { force: boolean; deleteBranch: boolean | "merged" },
): Promise<TaskFailure | null> {
  const result = await ipcCallResult("task", "remove", { id, ...options });
  return result.ok ? null : { kind: result.kind, message: result.message };
}
