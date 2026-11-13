/**
 * What a chat's side panel shows, as another device reads it (chat.panel,
 * and chat.watch's `panel`): the to-do list, the tasks and subagents, the
 * files the chat changed, the context it fills, what it cost, and its goal.
 */

import type { ChatPanel } from "../../../../packages/remote-protocol/src";
import type { CodexModel } from "../chat/codex-model";
import { shownGoalOf } from "../chat/goal";
import { agentsOf, changedFilesOf, contextOf, jobsOf, todosOf } from "../chat/panel";
import { type ChatSource, conversationOf, viewTaskOf } from "./chat-page";

/** The context window as the panel shows it: Claude's last count, or Codex's tokens. */
function contextOfModel(source: ChatSource): ChatPanel["context"] {
  const model = source.chat.model as CodexModel;
  if (source.agent === "codex") {
    const tokens = model.tokens;
    return tokens?.window && tokens.window > 0
      ? { usedTokens: tokens.used, maxTokens: tokens.window }
      : null;
  }
  const summary = contextOf(model.contextUsage);
  return summary && summary.maxTokens > 0
    ? { usedTokens: summary.totalTokens, maxTokens: summary.maxTokens }
    : null;
}

export function chatPanelOf(source: ChatSource): ChatPanel {
  const { tools } = conversationOf(source);
  const { model } = source.chat;
  const goal = shownGoalOf(source.chat);
  return {
    todos: todosOf(tools).map(({ content, status }) => ({ content, status })),
    tasks: jobsOf(model).map(viewTaskOf),
    agents: agentsOf(model).map((agent) => ({
      toolUseId: agent.toolUseId,
      description: agent.description,
      status: agent.status,
      ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
      ...(agent.endedAt !== undefined ? { endedAt: agent.endedAt } : {}),
    })),
    changedFiles: changedFilesOf(tools).map(({ path, added, removed }) => ({
      path,
      added,
      removed,
    })),
    context: contextOfModel(source),
    ...(model.costUsd !== undefined ? { costUsd: model.costUsd } : {}),
    goal: goal
      ? {
          condition: goal.objective,
          status: goal.status,
          ...(goal.setAt !== undefined ? { setAt: goal.setAt } : {}),
          checks: goal.checks.length,
          ...(goal.reason ? { reason: goal.reason } : {}),
        }
      : null,
  };
}
