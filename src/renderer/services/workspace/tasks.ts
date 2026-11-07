/**
 * Tasks: workspaces on git worktrees of another workspace's repository. Main
 * makes and removes the worktree; this side switches to the task and starts
 * its coding agent, in a Claude or Codex tab or a terminal.
 */

import { createLogger } from "../../../shared/log/renderer";
import type { ChatAgent, TaskAgent } from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta, WorkspaceTask } from "../../../shared/types/workspace";
import { ipcCallResult } from "../../ipc/client";
import { useActiveStore } from "../../state/stores/active";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { openAgentTab } from "../chat/agent-tab";
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
  // Asked to show a workspace, the window shows the workspaces.
  useAgentViewStore.getState().setMode("workspace");
  useActiveStore.getState().setActiveWorkspaceId(id);
  void ipcCallResult("workspace", "activate", { id }).then((result) => {
    if (!result.ok) log.warn(`workspace activate failed: ${result.message}`);
  });
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
 * Claude or Codex tab, or the command of a terminal ("" for none).
 */
export interface StartedTask {
  readonly task: WorkspaceMeta;
  readonly tabId: string;
  readonly start: TaskStart;
}

/**
 * Creates a task of `parentId` without switching to it, with one tab: an
 * agent's tab whose program starts now and is sent `prompt`, or a terminal
 * that runs the command with `prompt` once it starts, which is when the
 * task's panel is mounted. `createdBy` is the terminal whose agent asked
 * for it, if one did.
 */
export async function startTask(
  parentId: string,
  name: string,
  prompt: string,
  start: TaskStart,
  createdBy?: WorkspaceTask["createdBy"],
): Promise<StartedTask | TaskFailure> {
  const result = await ipcCallResult("task", "create", {
    parentId,
    name,
    ...(createdBy ? { createdBy } : {}),
  });
  if (!result.ok) return { kind: result.kind, message: result.message };

  useWorkspacesStore.getState().upsert(result.value);
  const task =
    useWorkspacesStore.getState().workspaces.find((w) => w.id === result.value.id) ??
    result.value;

  // A workspace that has a tab gets no terminal from its panel, so this tab
  // is the task's only one.
  if ("agent" in start) {
    const tabId = openAgentTab(task.id, start.agent, task.rootPath, prompt);
    return { task, tabId, start };
  }
  const { tabId } = openTerminal({ workspaceId: task.id, cwd: task.rootPath });
  const command = start.command.trim();
  if (command !== "") {
    queueStartupInput(
      task.id,
      tabId,
      (shellPath) => agentCommandLine(command, prompt, shellPath) ?? "",
    );
  }
  return { task, tabId, start: { command } };
}

/**
 * Creates a task of `parentId` and switches to it, with `agent`'s tab sent
 * `prompt`, or a plain terminal.
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
