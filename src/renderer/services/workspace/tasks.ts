import type { RelaySender, TerminalOpener } from "../../../shared/chat/relay";
import type { ChatAgent, TaskAgent } from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta, WorkspaceTask } from "../../../shared/types/workspace";
import { ipcCallResult } from "../../ipc/client";
import { activateWorkspace } from "../../state/operations/workspace-selection";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { openAgentTab, startAgentTab } from "../chat/agent-tab";
import { openTerminal } from "../terminal/open-terminal";
import { queueStartupInput } from "../terminal/pty-client";
import { quoteShellArgument } from "../terminal/shell-quote";

export interface TaskFailure {
  readonly kind: string;
  readonly message: string;
}

export function agentCommandLine(
  command: string,
  prompt: string,
  shellPath?: string,
): string | null {
  if (command === "") return null;
  const text = prompt.trim();
  return text === "" ? `${command}\r` : `${command} ${quoteShellArgument(text, shellPath)}\r`;
}

export type TaskStart = { readonly agent: ChatAgent } | { readonly command: string };

export function taskStartOf(agent: TaskAgent): TaskStart {
  return agent === "terminal" ? { command: "" } : { agent };
}

export interface StartedTask {
  readonly task: WorkspaceMeta;
  readonly tabId: string | null;
  readonly start: TaskStart;
  readonly preparationFailed?: true;
}

export async function startTask(
  parentId: string,
  name: string,
  prompt: string,
  start: TaskStart,
  createdBy?: WorkspaceTask["createdBy"],
  from?: RelaySender,
  openedBy?: TerminalOpener,
  preparation?: {
    beforeAgentStart: (task: WorkspaceMeta, tabId: string) => Promise<void>;
    fallbackPrompt: string;
  },
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

  if ("agent" in start) {
    const tabId = openAgentTab(
      task.id,
      start.agent,
      task.rootPath,
      preparation ? "" : prompt,
      undefined,
      from,
      openedBy,
    );
    if (preparation) {
      try {
        await preparation.beforeAgentStart(task, tabId);
      } catch {
        startAgentTab(task.id, tabId, preparation.fallbackPrompt, from);
        return { task, tabId, start, preparationFailed: true };
      }
      startAgentTab(task.id, tabId, prompt, from);
    }
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

export async function removeTask(
  id: string,
  options: { force: boolean; deleteBranch: boolean | "merged" },
): Promise<TaskFailure | null> {
  const result = await ipcCallResult("task", "remove", { id, ...options });
  return result.ok ? null : { kind: result.kind, message: result.message };
}
