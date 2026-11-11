/**
 * Claude and Codex tabs the app drives on its own, for a new task or the
 * nexus CLI: what each keeps of its conversation, as the tab's view keeps
 * it, and messages that start the conversation whether or not the tab is
 * ever shown.
 */

import { isDefaultProfileId } from "../../../shared/agent-profiles/profiles";
import type { RelaySender } from "../../../shared/chat/relay";
import { createLogger } from "../../../shared/log/renderer";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { openClaudeTab, openCodexTab } from "../../state/operations/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { type CodexController, type CodexTabHooks, codexController } from "./codex-controller";
import { type ChatController, type ChatTabHooks, chatController } from "./controller";
import { chatKey, useChatStore } from "./store";
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
    // The user's own name for it, whole, as the tab's rename menu keeps one.
    onRename: (title) => tabs().renameTab(workspaceId, tabId, title),
    onProfile: (profileId) =>
      tabs().setChatProfile(
        workspaceId,
        tabId,
        isDefaultProfileId(profileId) ? undefined : profileId,
      ),
    onMoves: (moves) => tabs().setChatMoves(workspaceId, tabId, moves),
    onRelayed: (record) => tabs().addChatRelayed(workspaceId, tabId, record),
  };
}

/** What a Codex tab keeps: the thread to go on with, and its title. */
export function codexTabHooks(workspaceId: string, tabId: string): CodexTabHooks {
  const tabs = () => useTabsStore.getState();
  return {
    onThread: (threadId) => tabs().setCodexThread(workspaceId, tabId, threadId),
    onFirstMessage: (text) => tabs().setProcessTitle(workspaceId, tabId, titleOf(text)),
    onTitle: (title) => tabs().setProcessTitle(workspaceId, tabId, clipTitle(title)),
    onProfile: (profileId) =>
      tabs().setChatProfile(
        workspaceId,
        tabId,
        isDefaultProfileId(profileId) ? undefined : profileId,
      ),
    onMoves: (moves) => tabs().setChatMoves(workspaceId, tabId, moves),
    onRelayed: (record) => tabs().addChatRelayed(workspaceId, tabId, record),
  };
}

/** A Claude or Codex tab's controller, and which agent it runs. */
export type AgentTabController =
  | { readonly agent: "claude"; readonly controller: ChatController }
  | { readonly agent: "codex"; readonly controller: CodexController };

/**
 * The controller of a Claude or Codex tab, made as its view makes it when
 * the view has not; null when the tab is neither, or gone.
 */
export function agentTabController(workspaceId: string, tabId: string): AgentTabController | null {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (tab?.type === "claude") {
    const { cwd, sessionId, fork, profileId, moves } = tab.props;
    return {
      agent: "claude",
      controller: chatController(
        {
          workspaceId,
          tabId,
          cwd,
          sessionId,
          fork,
          ...(profileId ? { profileId } : {}),
          ...(moves ? { moves } : {}),
        },
        claudeTabHooks(workspaceId, tabId),
      ),
    };
  }
  if (tab?.type === "codex") {
    const { cwd, threadId, fork, profileId, moves } = tab.props;
    return {
      agent: "codex",
      controller: codexController(
        {
          workspaceId,
          tabId,
          cwd,
          threadId,
          fork,
          ...(profileId ? { profileId } : {}),
          ...(moves ? { moves } : {}),
        },
        codexTabHooks(workspaceId, tabId),
      ),
    };
  }
  return null;
}

/**
 * Messages sent to tabs that their conversation does not show yet, by chat
 * key: how many messages of the user's it showed when one was sent. Until it
 * shows more, the tab counts as working, though no turn has begun.
 */
const unseenSends = new Map<string, number>();

function userMessages(key: string): number {
  const chat = useChatStore.getState().tabs[key];
  return chat ? chat.model.items.filter((item) => item.kind === "user").length : 0;
}

/** Whether a message sent to the tab is yet to show in its conversation. */
export function sendUnseen(workspaceId: string, tabId: string): boolean {
  const key = chatKey(workspaceId, tabId);
  const before = unseenSends.get(key);
  if (before === undefined) return false;
  if (userMessages(key) <= before) return true;
  unseenSends.delete(key);
  return false;
}

/**
 * Sends `text` to a tab, starting its program if it is not running; the tab
 * counts as working from now, not only once the message shows. `from`: the
 * agent that sent it through the nexus command, when one did.
 */
export async function sendToAgentTab(
  workspaceId: string,
  tabId: string,
  { controller }: AgentTabController,
  text: string,
  from?: RelaySender,
): Promise<void> {
  const key = chatKey(workspaceId, tabId);
  unseenSends.set(key, userMessages(key));
  try {
    await controller.send(text, [], from);
  } catch (err) {
    unseenSends.delete(key);
    throw err;
  }
}

/**
 * Starts the program of a new Claude or Codex tab and sends it `message`
 * when there is one, from the agent that asked for the tab (`from`) when
 * one did; shown or not, the conversation starts now.
 */
export function startAgentTab(
  workspaceId: string,
  tabId: string,
  message: string,
  from?: RelaySender,
): void {
  const text = message.trim();
  const target = agentTabController(workspaceId, tabId);
  if (text === "" || !target) return;
  const key = chatKey(workspaceId, tabId);
  // Working from now: opening the program comes before the message.
  unseenSends.set(key, 0);
  void target.controller
    .open()
    .then(() => sendToAgentTab(workspaceId, tabId, target, text, from))
    .catch((err: Error) => {
      unseenSends.delete(key);
      log.warn(`first message to ${target.agent} tab not sent: ${err.message}`);
    });
}

/**
 * Opens a new `agent` tab in `cwd`, in the workspace's active group, and
 * sends it `message` when there is one (see startAgentTab). Returns the
 * tab's id.
 */
export function openAgentTab(
  workspaceId: string,
  agent: ChatAgent,
  cwd: string,
  message: string,
  profileId?: string,
  from?: RelaySender,
): string {
  const props = { cwd, ...(profileId ? { profileId } : {}) };
  const { id: tabId } =
    agent === "claude" ? openClaudeTab(workspaceId, props) : openCodexTab(workspaceId, props);
  startAgentTab(workspaceId, tabId, message, from);
  return tabId;
}
