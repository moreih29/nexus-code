/**
 * What the agent list does for the user: show the list itself, a session's
 * terminal, type a line into it, show a worktree's changes or a file's,
 * open a terminal or a conversation in it, and make or delete a task
 * through the app's own dialogs.
 */

import { EMPTY_TREE } from "@/components/editor/diff-refs";
import { openClaudeTab, openDiffTab } from "@/state/operations/tabs";
import { useActiveStore } from "@/state/stores/active";
import { isAgentViewShown, useAgentViewStore } from "@/state/stores/agent-view";
import { useGitStore } from "@/state/stores/git";
import { useLayoutStore } from "@/state/stores/layout/store";
import { useTaskUIStore } from "@/state/stores/task-ui";
import { useUIStore } from "@/state/stores/ui";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { showInAgentView } from "../agent-view/show";
import { existingCodexController } from "../chat/codex-controller";
import { existingChatController } from "../chat/controller";
import { actionHandlers, UiRequestError } from "../cli/actions";
import { groupOf } from "../cli/placement";
import { requestTabFocus } from "../tab-focus";
import { openTerminal } from "../terminal/open-terminal";
import { getTerminalController } from "../terminal/terminal-registry";
import { activateWorkspace } from "../workspace/tasks";
import { typeText } from "./typed-input";

interface SessionRef {
  readonly workspaceId: string;
  readonly tabId: string;
  /** A Claude or Codex tab's program takes a message as a request. */
  readonly kind?: "terminal" | "claude" | "codex";
}

/** What the agent list asks of a chat tab's program. */
interface ChatTab {
  send(text: string): Promise<void>;
}

/** The controller of a Claude or Codex tab's session; an error when the tab was never shown. */
function chatTab({ workspaceId, tabId, kind }: SessionRef): ChatTab {
  const chat =
    kind === "codex"
      ? existingCodexController(workspaceId, tabId)
      : existingChatController(workspaceId, tabId);
  if (!chat) {
    const name = kind === "codex" ? "Codex" : "Claude";
    throw new UiRequestError(`that ${name} tab has not started: it has not been shown yet`);
  }
  return chat;
}

/**
 * Shows the session's terminal: in the agent view while it is up, else
 * switching to the session's workspace.
 */
export function showTerminal(session: SessionRef): void {
  if (isAgentViewShown()) {
    showInAgentView(session.workspaceId, session.tabId, { focus: false });
    return;
  }
  revealInWorkspace(session);
}

/** Switches to the session's workspace and shows its terminal there. */
export function revealInWorkspace({ workspaceId, tabId }: SessionRef): void {
  const groupId = groupOf(workspaceId, tabId);
  if (!groupId) return;
  // The tab first: switching to the workspace then lands on it, rather than
  // on the tab it showed before, which would count as looked at.
  useLayoutStore.getState().setActiveTabInGroup({ workspaceId, groupId, tabId });
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
}

/** Goes to the session's tab in its workspace, leaving the agent view. */
export function openInWorkspace(session: SessionRef): void {
  useAgentViewStore.getState().setMode("workspace");
  revealInWorkspace(session);
  requestTabFocus(session.tabId);
}

/**
 * The wait before Enter. Codex takes an Enter within 120 ms of fast input as
 * a new line, not a send (60 ms longer on Windows).
 */
const SUBMIT_DELAY_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Types `text` into the session's terminal as keys and presses Enter. */
export async function sendLine(session: SessionRef, text: string): Promise<void> {
  if (session.kind === "claude" || session.kind === "codex") {
    await chatTab(session).send(text);
    return;
  }
  const terminal = getTerminalController(session.tabId);
  if (!terminal) {
    throw new UiRequestError(
      "that terminal has not started: its workspace has not been opened since NexusCode started",
    );
  }
  await typeText(
    {
      write: (chunk) => {
        if (!terminal.input(chunk, "keys")) throw new UiRequestError("that terminal has closed");
      },
      nextOutput: (timeoutMs) => terminal.nextOutput(timeoutMs),
    },
    text,
  );
  await sleep(SUBMIT_DELAY_MS);
  await actionHandlers["terminal.input"]({ ...session, text: "", mode: "keys", enter: true });
}

/** Shows the workspace's agent list: its files panel on the agents view. */
export function showAgentList(workspaceId: string): void {
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
  const ui = useUIStore.getState();
  ui.setFilesPanelMode(workspaceId, "agents");
  ui.setPanelHidden("files", false);
}

/** Opens the diff of a worktree's uncommitted change to a file, in its workspace. */
export function showFileChange(workspaceId: string, relPath: string): void {
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
  const unborn =
    useGitStore.getState().sessions.get(workspaceId)?.status?.branch?.isUnborn ?? false;
  openDiffTab(workspaceId, relPath, unborn ? EMPTY_TREE : "HEAD", "WORKING");
}

/** Switches to the worktree with its files panel on the git view. */
export function showChanges(workspaceId: string): void {
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
  const ui = useUIStore.getState();
  ui.setFilesPanelMode(workspaceId, "git");
  ui.setPanelHidden("files", false);
}

/** Opens a terminal in the worktree's workspace and switches to it. */
export function openWorktreeTerminal(workspace: WorkspaceMeta): void {
  openTerminal({ workspaceId: workspace.id, cwd: workspace.rootPath });
  if (useActiveStore.getState().activeWorkspaceId !== workspace.id) activateWorkspace(workspace.id);
}

/** Starts a Claude conversation in the worktree's workspace and switches to it. */
export function openWorktreeChat(workspace: WorkspaceMeta): void {
  openClaudeTab(workspace.id, { cwd: workspace.rootPath });
  if (useActiveStore.getState().activeWorkspaceId !== workspace.id) activateWorkspace(workspace.id);
}

export function newTask(rootId: string): void {
  useTaskUIStore.getState().openNewTask(rootId);
}

export function removeTask(taskId: string): void {
  useTaskUIStore.getState().openRemoveTask(taskId);
}
