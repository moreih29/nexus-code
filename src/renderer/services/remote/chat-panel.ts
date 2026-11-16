/**
 * What a chat's side panel shows, as another device reads it (chat.panel,
 * and chat.watch's `panel`): the to-do list, the tasks and subagents, the
 * files the chat changed, the context it fills, what it cost, and its goal;
 * a Claude chat's MCP servers, program and Remote Control too, where it
 * went on in another profile, and what another device can do with it.
 */

import {
  type ChatPanel,
  MAX_HELD_TEXT,
  type ViewGoal,
  type ViewUsageMeter,
} from "../../../../packages/remote-protocol/src";
import type { CodexModel } from "../chat/codex-model";
import { type GoalView, shownGoalOf } from "../chat/goal";
import type { ChatItem } from "../chat/model";
import { agentsOf, changedFilesOf, contextOf, jobsOf, todosOf } from "../chat/panel";
import { followsMessage } from "../chat/profile-moves";
import type { QueuedMessage } from "../chat/store";
import { claudeUsageLine, codexUsageLine } from "../chat/usage-line";
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

/**
 * The plan's usage limits as the composer's line shows them, the session's
 * and the week's first: the profile's as this app last heard them, else
 * what the program last told the tab. None for a profile with no plan.
 */
export function planLimitsOf(source: ChatSource, now = Date.now()): ViewUsageMeter[] {
  const model = source.chat.model as CodexModel;
  const line =
    source.agent === "codex"
      ? codexUsageLine(
          { tokens: undefined, rateLimits: source.plan?.codex ?? model.rateLimits },
          now,
        )
      : claudeUsageLine(
          { contextUsage: undefined, usage: source.plan?.claude ?? source.chat.model.usage },
          now,
        );
  return line ? [...line.meters, ...line.more] : [];
}

/** The most checks of a goal the panel tells, the latest; and of what each said. */
const GOAL_CHECKS = 20;
const GOAL_REASON_CHARS = 500;

/** A goal as the panel shows it: what it is, how it stands, what its checks said. */
function viewGoalOf(goal: GoalView): ViewGoal {
  const checkReasons = goal.checks.slice(-GOAL_CHECKS).map((check) => ({
    ...(check.at !== undefined ? { at: check.at } : {}),
    reason: check.reason.slice(0, GOAL_REASON_CHARS),
  }));
  return {
    condition: goal.objective,
    status: goal.status,
    ...(goal.setAt !== undefined ? { setAt: goal.setAt } : {}),
    checks: goal.checks.length,
    ...(goal.reason ? { reason: goal.reason } : {}),
    ...(checkReasons.length > 0 ? { checkReasons } : {}),
    ...(goal.usedSeconds !== undefined ? { usedSeconds: goal.usedSeconds } : {}),
    ...(goal.usedAt !== undefined ? { usedAt: goal.usedAt } : {}),
    ...(goal.tokens !== undefined ? { tokens: goal.tokens } : {}),
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    ...(goal.durationMs !== undefined ? { durationMs: goal.durationMs } : {}),
    ...(goal.endedAt !== undefined ? { endedAt: goal.endedAt } : {}),
    ...(goal.iterations !== undefined ? { iterations: goal.iterations } : {}),
  };
}

/** Each move by the key of the item it follows; one whose message is not in the conversation is left out. */
function movesOf(source: ChatSource, items: readonly ChatItem[]): NonNullable<ChatPanel["moves"]> {
  return (source.moves ?? []).flatMap((move) => {
    const item = items.findLast((i) => followsMessage(i, move.after));
    return item ? [{ after: item.key, profile: move.profile, at: move.at }] : [];
  });
}

/**
 * What a Claude tab's panel tells beside: the plan's limit as its banner
 * says it, its MCP servers, what its program runs as, and Remote Control.
 */
function claudeExtrasOf(source: ChatSource): Partial<ChatPanel> {
  const { model } = source.chat;
  const limit = model.rateLimit;
  const account = model.init?.account;
  const signedIn = account
    ? [
        account.email,
        account.organization,
        account.subscription,
        account.provider && account.provider !== "firstParty" ? account.provider : undefined,
      ].filter(Boolean)
    : [];
  const version = source.chat.version ?? model.version;
  const session = {
    ...(model.sessionId ? { id: model.sessionId } : {}),
    ...(version ? { version } : {}),
    ...(signedIn.length > 0 ? { account: signedIn.join(" · ") } : {}),
  };
  return {
    ...(limit
      ? {
          rateLimit: {
            status: limit.status,
            // The program tells it in seconds.
            ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt * 1000 } : {}),
            ...(limit.rateLimitType ? { kind: limit.rateLimitType } : {}),
          },
        }
      : {}),
    ...(model.mcp
      ? {
          mcp: model.mcp.map((server) => ({
            name: server.name,
            status: server.status,
            ...(server.scope ? { scope: server.scope } : {}),
            ...(server.transport ? { transport: server.transport } : {}),
          })),
        }
      : {}),
    ...(Object.keys(session).length > 0 ? { session } : {}),
    ...(model.init
      ? {
          remoteControl: {
            available: model.init.remoteControl,
            enabled: model.remoteControl?.enabled === true,
            ...(model.remoteControl?.enabled && model.remoteControl.sessionUrl
              ? { url: model.remoteControl.sessionUrl }
              : {}),
          },
        }
      : {}),
  };
}

export function chatPanelOf(source: ChatSource, now = Date.now()): ChatPanel {
  const { tools, items } = conversationOf(source);
  const { model } = source.chat;
  const goal = shownGoalOf(source.chat);
  const planLimits = planLimitsOf(source, now);
  const moves = movesOf(source, items);
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
    changedFiles: changedFilesOf(tools).map(({ path, added, removed, created }) => ({
      path,
      added,
      removed,
      ...(created ? { created } : {}),
    })),
    context: contextOfModel(source),
    ...(model.costUsd !== undefined ? { costUsd: model.costUsd } : {}),
    ...(planLimits.length > 0 ? { planLimits } : {}),
    goal: goal ? viewGoalOf(goal) : null,
    ...(source.agent === "claude" ? claudeExtrasOf(source) : {}),
    ...(moves.length > 0 ? { moves } : {}),
    ...(source.can ? { can: source.can } : {}),
    ...(source.chat.queue.length > 0 ? { held: source.chat.queue.map(heldOf) } : {}),
  };
}

/** A message the tab holds for after its turn, as the panel tells it: its text cut short. */
function heldOf(item: QueuedMessage): NonNullable<ChatPanel["held"]>[number] {
  const truncated = item.text.length > MAX_HELD_TEXT;
  return {
    id: item.id,
    text: truncated ? item.text.slice(0, MAX_HELD_TEXT) : item.text,
    ...(truncated ? { truncated } : {}),
    ...(item.images.length > 0 ? { images: item.images.length } : {}),
  };
}
