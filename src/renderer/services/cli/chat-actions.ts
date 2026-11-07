/**
 * The nexus CLI's requests for Claude and Codex tabs: open one with a
 * message, tell where one stands, read its conversation or one tool call of
 * it, send it a message, answer its permission request.
 * A tab not shown since the app started is opened first, as showing it
 * would: its program's log is read, and the program started when it is
 * gone.
 */

import type { CliUiOp } from "../../../shared/cli/ui";
import {
  type AgentTabController,
  agentTabController,
  sendToAgentTab,
  sendUnseen,
  startAgentTab,
} from "../chat/agent-tab";
import { chatKey, useChatStore } from "../chat/store";
import { chatEntriesOf, chatInfoOf, chatToolOf } from "./chat-view";
import { type CliUiHandler, UiRequestError } from "./handler";
import { openTab } from "./placement";

type ChatOp = Extract<CliUiOp, `chat.${string}`>;

/** Whether the tab's conversation was opened since the app started. */
function opened(workspaceId: string, tabId: string): boolean {
  return useChatStore.getState().tabs[chatKey(workspaceId, tabId)] !== undefined;
}

async function openedTab(workspaceId: string, tabId: string): Promise<AgentTabController> {
  const target = agentTabController(workspaceId, tabId);
  if (!target) throw new UiRequestError("that tab is not a Claude or Codex tab");
  if (!opened(workspaceId, tabId)) await target.controller.open();
  return target;
}

function infoOf(workspaceId: string, tabId: string, { agent }: AgentTabController) {
  const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
  return chatInfoOf(agent, chat, sendUnseen(workspaceId, tabId));
}

export const chatHandlers: { [K in ChatOp]: CliUiHandler<K> } = {
  "chat.open": async ({ workspaceId, agent, cwd, prompt, placement }) => {
    const tab =
      agent === "claude"
        ? ({ type: "claude", props: { cwd } } as const)
        : ({ type: "codex", props: { cwd } } as const);
    const tabId = openTab(workspaceId, tab, placement);
    startAgentTab(workspaceId, tabId, prompt);
    return { tabId };
  },

  "chat.state": async ({ workspaceId, tabId, peek }) => {
    if (peek && !opened(workspaceId, tabId)) {
      const target = agentTabController(workspaceId, tabId);
      if (!target) throw new UiRequestError("that tab is not a Claude or Codex tab");
      return chatInfoOf(target.agent, undefined, false);
    }
    return infoOf(workspaceId, tabId, await openedTab(workspaceId, tabId));
  },

  "chat.read": async ({ workspaceId, tabId, messages, since, subagents }) => {
    const target = await openedTab(workspaceId, tabId);
    const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
    return {
      ...infoOf(workspaceId, tabId, target),
      ...chatEntriesOf(chat, { messages, since, subagents }),
    };
  },

  "chat.tool": async ({ workspaceId, tabId, ref }) => {
    await openedTab(workspaceId, tabId);
    const tool = chatToolOf(useChatStore.getState().tabs[chatKey(workspaceId, tabId)], ref);
    if (!tool) throw new UiRequestError(`no tool call "${ref}" in that tab`);
    return tool;
  },

  "chat.send": async ({ workspaceId, tabId, text }) => {
    const target = await openedTab(workspaceId, tabId);
    if (infoOf(workspaceId, tabId, target).state === "asking") {
      throw new UiRequestError(
        "it is waiting for the user to answer a request; that is for the user to answer",
      );
    }
    await sendToAgentTab(workspaceId, tabId, target, text);
    return {};
  },

  "chat.answer": async ({ workspaceId, tabId, decision, message, expect }) => {
    const target = await openedTab(workspaceId, tabId);
    // Main allowed an answer to the request the tab asked then: not to another.
    const request = useChatStore.getState().tabs[chatKey(workspaceId, tabId)]?.model.permissions[0];
    if (!request) throw new UiRequestError("it no longer asks anything");
    if (request.requestId !== expect) {
      throw new UiRequestError("its request changed or was answered; read it again");
    }
    await target.controller.answerPermission(
      request,
      decision === "allow" ? { kind: "allow" } : { kind: "deny", message: message ?? "" },
    );
    return {};
  },
};
