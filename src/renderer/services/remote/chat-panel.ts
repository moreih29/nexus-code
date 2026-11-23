import {
  type ChatPanel,
  MAX_HELD_TEXT,
  type ViewGoal,
  type ViewUsageMeter,
} from "../../../../packages/remote-protocol/src";
import { codexServerVersion } from "../chat/codex/history";
import type { CodexModel } from "../chat/codex/model";
import { type GoalView, shownGoalOf } from "../chat/goal";
import type { ChatItem, ToolCall } from "../chat/model";
import { agentsOf, changedFilesOf, contextOf, jobsOf, todosOf } from "../chat/panel";
import { followsMessage } from "../chat/profile-moves";
import type { QueuedMessage } from "../chat/transport/queue";
import type { PeerSubmission } from "../chat/transport/submission";
import { claudeUsageLine, codexUsageLine } from "../chat/usage-line";
import { type ChatSource, conversationOf, viewTaskOf } from "./chat-page";

function contextOfModel(source: ChatSource): ChatPanel["context"] {
  const model = source.chat.model as CodexModel;
  if (source.agent === "codex") {
    const tokens = model.tokens;
    return tokens?.window && tokens.window > 0
      ? { usedTokens: tokens.used, maxTokens: tokens.window }
      : null;
  }
  const summary = contextOf(model.contextUsage);
  if (!summary || summary.maxTokens <= 0) return null;
  const tokens = (n: number) => Math.max(0, Math.round(n));
  return {
    usedTokens: summary.totalTokens,
    maxTokens: summary.maxTokens,
    ...(summary.used.length > 0
      ? {
          categories: summary.used
            .slice(0, MAX_CONTEXT_CATEGORIES)
            .map(({ name, tokens: n }) => ({ name: name.slice(0, 200), tokens: tokens(n) })),
        }
      : {}),
    ...(summary.free !== undefined ? { freeTokens: tokens(summary.free) } : {}),
  };
}

const MAX_CONTEXT_CATEGORIES = 50;

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

const GOAL_CHECKS = 20;
const GOAL_REASON_CHARS = 500;

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

function movesOf(source: ChatSource, items: readonly ChatItem[]): NonNullable<ChatPanel["moves"]> {
  return (source.moves ?? []).flatMap((move) => {
    const item = items.findLast((i) => followsMessage(i, move.after));
    return item ? [{ after: item.key, profile: move.profile, at: move.at }] : [];
  });
}

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

function codexMcpStatus(status: string, needsLogin?: boolean): string {
  if (status === "disabled") return status;
  if (needsLogin || status === "notLoggedIn" || status === "authenticationRequired")
    return "needs-auth";
  if (status === "starting") return "pending";
  return status || "unknown";
}

function codexExtrasOf(source: ChatSource, model: CodexModel): Partial<ChatPanel> {
  const version = codexServerVersion(model, source.chat.version) ?? model.version;
  const session = {
    ...(model.threadId ? { id: model.threadId } : {}),
    ...(version ? { version } : {}),
    ...(model.account ? { account: model.account.type } : {}),
  };
  return {
    ...(Object.keys(session).length > 0 ? { session } : {}),
    ...(model.mcpServers
      ? {
          mcp: model.mcpServers.map(({ name, status, needsLogin }) => ({
            name,
            status: codexMcpStatus(status, needsLogin),
          })),
        }
      : {}),
  };
}

const fileSummaries = new WeakMap<Record<string, ToolCall>, ChatPanel["changedFiles"]>();

function changedFileSummaries(tools: Record<string, ToolCall>): ChatPanel["changedFiles"] {
  const cached = fileSummaries.get(tools);
  if (cached) return cached;
  const files = changedFilesOf(tools).map(({ path, added, removed, created }) => ({
    path,
    added,
    removed,
    ...(created ? { created } : {}),
  }));
  fileSummaries.set(tools, files);
  return files;
}

export function chatPanelOf(source: ChatSource, now = Date.now()): ChatPanel {
  const { history, model } = source.chat;
  const tools = history ? { ...history.tools, ...model.tools } : model.tools;
  const codex = source.agent === "codex" ? (model as CodexModel) : null;
  const goal = shownGoalOf(source.chat);
  const planLimits = planLimitsOf(source, now);
  const moves = source.moves?.length ? movesOf(source, conversationOf(source).items) : [];
  return {
    todos: codex?.plan ?? todosOf(tools).map(({ content, status }) => ({ content, status })),
    tasks: jobsOf(model).map((job) => viewTaskOf(job, tools)),
    agents: agentsOf(model).map((agent) => ({
      toolUseId: agent.toolUseId,
      description: agent.description,
      ...(codex && agent.prompt ? { prompt: agent.prompt.slice(0, 8_192) } : {}),
      status: agent.status,
      ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
      ...(agent.endedAt !== undefined ? { endedAt: agent.endedAt } : {}),
    })),
    changedFiles: changedFileSummaries(tools),
    context: contextOfModel(source),
    ...(model.costUsd !== undefined ? { costUsd: model.costUsd } : {}),
    ...(planLimits.length > 0 ? { planLimits } : {}),
    goal: goal ? viewGoalOf(goal) : null,
    ...(codex ? codexExtrasOf(source, codex) : claudeExtrasOf(source)),
    ...(moves.length > 0 ? { moves } : {}),
    ...(source.twin ? { twin: { tabId: source.twin } } : {}),
    ...limitResumeOf(source),
    ...(source.can
      ? { can: { ...source.can, clientNonce: true, ...(codex ? { mcpStatus: true } : {}) } }
      : {}),
    ...(source.chat.queue.length > 0
      ? {
          held: source.chat.queue.map((item) =>
            heldOf(item, source.chat.peerSubmissions?.[item.id]),
          ),
        }
      : {}),
  };
}

function limitResumeOf({ limitResume: record }: ChatSource): Pick<ChatPanel, "limitResume"> {
  if (!record || record.state === "sent") return {};
  return {
    limitResume: {
      state: record.state,
      stopAt: record.stopAt,
      ...(record.at !== undefined ? { at: record.at } : {}),
      ...(record.resetsAt !== undefined ? { resetsAt: record.resetsAt } : {}),
      ...(record.tries > 0 ? { tries: record.tries } : {}),
    },
  };
}

function heldOf(
  item: QueuedMessage,
  submission?: PeerSubmission,
): NonNullable<ChatPanel["held"]>[number] {
  const truncated = item.text.length > MAX_HELD_TEXT;
  return {
    id: item.id,
    ...(submission
      ? { clientNonce: submission.clientNonce, clientDeviceId: submission.clientDeviceId }
      : {}),
    ...(item.status ? { status: item.status } : {}),
    ...(item.error ? { error: item.error } : {}),
    text: truncated ? item.text.slice(0, MAX_HELD_TEXT) : item.text,
    ...(truncated ? { truncated } : {}),
    ...(item.images.length > 0 ? { images: item.images.length } : {}),
  };
}
