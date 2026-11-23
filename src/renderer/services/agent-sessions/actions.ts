import { EMPTY_TREE } from "@/components/editor/diff-refs";
import { openClaudeTab, openDiffTab } from "@/state/operations/tabs";
import { useActiveStore } from "@/state/stores/active";
import { isAgentViewShown, useAgentViewStore } from "@/state/stores/agent-view";
import { useGitStore } from "@/state/stores/git";
import { useLayoutStore } from "@/state/stores/layout/store";
import { useTaskUIStore } from "@/state/stores/task-ui";
import { useUIStore } from "@/state/stores/ui";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { activateWorkspace } from "../../state/operations/workspace-selection";
import { showInAgentView } from "../agent-view/show";
import { existingChatController } from "../chat/claude/controller";
import { existingCodexController } from "../chat/codex/controller";
import { actionHandlers, UiRequestError } from "../cli/actions";
import { groupOf } from "../cli/placement";
import { requestTabFocus } from "../tab-focus";
import { openTerminal } from "../terminal/open-terminal";
import { getTerminalController } from "../terminal/terminal-registry";
import { typeText } from "./typed-input";

interface SessionRef {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly kind?: "terminal" | "claude" | "codex";
}

interface ChatTab {
  send(text: string): Promise<void>;
}

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

export function showTerminal(session: SessionRef): void {
  if (isAgentViewShown()) {
    showInAgentView(session.workspaceId, session.tabId, { focus: false });
    return;
  }
  revealInWorkspace(session);
}

export function revealInWorkspace({ workspaceId, tabId }: SessionRef): void {
  const groupId = groupOf(workspaceId, tabId);
  if (!groupId) return;
  useLayoutStore.getState().setActiveTabInGroup({ workspaceId, groupId, tabId });
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
}

export function openInWorkspace(session: SessionRef): void {
  useAgentViewStore.getState().setMode("workspace");
  revealInWorkspace(session);
  requestTabFocus(session.tabId);
}

const SUBMIT_DELAY_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

export function showAgentList(workspaceId: string): void {
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
  const ui = useUIStore.getState();
  ui.setFilesPanelMode(workspaceId, "agents");
  ui.setPanelHidden("files", false);
}

export function showFileChange(workspaceId: string, relPath: string): void {
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
  const unborn =
    useGitStore.getState().sessions.get(workspaceId)?.status?.branch?.isUnborn ?? false;
  openDiffTab(workspaceId, relPath, unborn ? EMPTY_TREE : "HEAD", "WORKING");
}

export function showChanges(workspaceId: string): void {
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
  const ui = useUIStore.getState();
  ui.setFilesPanelMode(workspaceId, "git");
  ui.setPanelHidden("files", false);
}

export function openWorktreeTerminal(workspace: WorkspaceMeta): void {
  openTerminal({ workspaceId: workspace.id, cwd: workspace.rootPath });
  if (useActiveStore.getState().activeWorkspaceId !== workspace.id) activateWorkspace(workspace.id);
}

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
