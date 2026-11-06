/**
 * Claude and Codex tabs the app opens on its own: what each keeps of its
 * conversation, as the tab's view keeps it, and a first message that starts
 * the conversation whether or not the tab is ever shown.
 */

import { createLogger } from "../../../shared/log/renderer";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { openClaudeTab, openCodexTab } from "../../state/operations/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { type CodexTabHooks, codexController } from "./codex-controller";
import { type ChatTabHooks, chatController } from "./controller";
import { clipTitle, titleOf } from "./tab-title";

const log = createLogger("chat");

/** What a Claude tab keeps: the session to go on with, and its title. */
export function claudeTabHooks(workspaceId: string, tabId: string): ChatTabHooks {
  const tabs = () => useTabsStore.getState();
  return {
    onSession: (sessionId) => tabs().setClaudeSession(workspaceId, tabId, sessionId),
    onTarget: (target) => tabs().setClaudeTarget(workspaceId, tabId, target),
    onFirstMessage: (text) => tabs().setProcessTitle(workspaceId, tabId, titleOf(text)),
    onTitle: (title) => tabs().setProcessTitle(workspaceId, tabId, clipTitle(title)),
  };
}

/** What a Codex tab keeps: the thread to go on with, and its title. */
export function codexTabHooks(workspaceId: string, tabId: string): CodexTabHooks {
  const tabs = () => useTabsStore.getState();
  return {
    onThread: (threadId) => tabs().setCodexThread(workspaceId, tabId, threadId),
    onFirstMessage: (text) => tabs().setProcessTitle(workspaceId, tabId, titleOf(text)),
    onTitle: (title) => tabs().setProcessTitle(workspaceId, tabId, clipTitle(title)),
  };
}

/**
 * Opens a new `agent` tab in `cwd`, in the workspace's active group, and
 * sends it `message` when there is one: its program starts now, shown or
 * not, and the message goes once it runs. Returns the tab's id.
 */
export function openAgentTab(
  workspaceId: string,
  agent: ChatAgent,
  cwd: string,
  message: string,
): string {
  const { id: tabId } =
    agent === "claude" ? openClaudeTab(workspaceId, { cwd }) : openCodexTab(workspaceId, { cwd });
  const text = message.trim();
  if (text !== "") {
    const controller =
      agent === "claude"
        ? chatController({ workspaceId, tabId, cwd }, claudeTabHooks(workspaceId, tabId))
        : codexController({ workspaceId, tabId, cwd }, codexTabHooks(workspaceId, tabId));
    void controller
      .open()
      .then(() => controller.send(text))
      .catch((err: Error) => log.warn(`first message to ${agent} tab not sent: ${err.message}`));
  }
  return tabId;
}
