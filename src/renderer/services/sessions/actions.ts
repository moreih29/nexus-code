/**
 * What the sessions tab does for the user: show a session's terminal, type
 * a line into it or interrupt it, show a worktree's changes, and make or
 * delete a task through the app's own dialogs.
 */

import { useActiveStore } from "@/state/stores/active";
import { useLayoutStore } from "@/state/stores/layout/store";
import { useTaskUIStore } from "@/state/stores/task-ui";
import { useUIStore } from "@/state/stores/ui";
import { existingCodexController } from "../chat/codex-controller";
import { existingChatController } from "../chat/controller";
import { actionHandlers, UiRequestError } from "../cli/actions";
import { groupOf } from "../cli/placement";
import { getTerminalController } from "../terminal/terminal-registry";
import { activateWorkspace } from "../workspace/tasks";
import { typeText } from "./typed-input";

interface SessionRef {
  readonly workspaceId: string;
  readonly tabId: string;
  /** A Claude or Codex tab's program takes a message, and an interrupt, as requests. */
  readonly kind?: "terminal" | "claude" | "codex";
}

/** What the sessions tab asks of a chat tab's program. */
interface ChatTab {
  send(text: string): Promise<void>;
  interrupt(): Promise<unknown>;
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

/** Switches to the session's workspace and shows its terminal. */
export function showTerminal({ workspaceId, tabId }: SessionRef): void {
  const groupId = groupOf(workspaceId, tabId);
  if (!groupId) return;
  // The tab first: switching to the workspace then lands on it, rather than
  // on the tab it showed before, which would count as looked at.
  useLayoutStore.getState().setActiveTabInGroup({ workspaceId, groupId, tabId });
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
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

/** Presses Ctrl-C in the session's terminal. */
export async function interrupt(session: SessionRef): Promise<void> {
  if (session.kind === "claude" || session.kind === "codex") {
    await chatTab(session).interrupt();
    return;
  }
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
