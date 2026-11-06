/**
 * What a session's row in the agents tab says beside its state: what it
 * waits on (a permission, a question, a plan), the call it runs now, and how
 * far it is (its to-dos, its subagents, its context). A chat tab tells it
 * from its conversation, a terminal running Claude from what its hooks
 * report. Pure.
 */

import type { SessionActivity } from "../../../shared/claude/activity";
import type { TerminalWait } from "../../../shared/sessions/agent-state";
import type { ChatModel, ToolCall } from "../chat/model";
import { agentsOf as chatAgentsOf, contextOf, todosOf } from "../chat/panel";
import { currentTool, liveAgents, shortTarget } from "./agents";
import type { AgentSession } from "./model";

/** The groups of the list, in its order: the user's turn first, those ended last. */
export const ROW_GROUPS = ["attention", "running", "done", "idle", "ended"] as const;
export type RowGroup = (typeof ROW_GROUPS)[number];

export function groupOf(session: AgentSession): RowGroup {
  if (session.state === "exited") return "ended";
  return session.phase;
}

/** Whether `session` has `query` in its title, last prompt or last answer; any does for none. */
export function matchesQuery(session: AgentSession, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return (
    needle === "" ||
    [session.title, session.prompt, session.message].some((text) =>
      text?.toLowerCase().includes(needle),
    )
  );
}

/**
 * The sessions of `group` that match `query`: those waiting longest first
 * among the ones waiting on the user, the latest first elsewhere.
 */
export function sessionsIn(
  sessions: readonly AgentSession[],
  group: RowGroup,
  query: string,
): AgentSession[] {
  const order = group === "attention" ? 1 : -1;
  return sessions
    .filter((session) => groupOf(session) === group && matchesQuery(session, query))
    .sort((a, b) => order * ((a.since ?? 0) - (b.since ?? 0)));
}

/** The sessions that match `query`, group by group in the list's order. */
export function sessionsByGroup(sessions: readonly AgentSession[], query: string): AgentSession[] {
  return ROW_GROUPS.flatMap((group) => sessionsIn(sessions, group, query));
}

/**
 * The session `session` waits on to end (nexus terminal wait), among
 * `sessions`. A waiter no longer running was interrupted, whatever the
 * registry still says.
 */
export function waitedOn(
  session: AgentSession,
  waits: readonly TerminalWait[],
  sessions: readonly AgentSession[],
): AgentSession | undefined {
  if (session.phase !== "running") return undefined;
  const wait = waits.find(
    (each) =>
      each.waiter.workspaceId === session.workspaceId && each.waiter.tabId === session.tabId,
  );
  if (!wait) return undefined;
  return sessions.find(
    (each) => each.workspaceId === wait.target.workspaceId && each.tabId === wait.target.tabId,
  );
}

/** What a session waits on the user for. */
export type RowWait =
  | { readonly kind: "permission"; readonly tool: string; readonly target: string | undefined }
  | { readonly kind: "question"; readonly text: string; readonly count: number }
  | { readonly kind: "plan"; readonly text: string };

export interface RowFacts {
  readonly wait: RowWait | undefined;
  /** The call the session runs now, on the main thread. */
  readonly tool: { readonly name: string; readonly target: string | undefined } | undefined;
  readonly todos: { readonly done: number; readonly total: number } | undefined;
  /** Subagents running now. */
  readonly subagents: number;
  /** How full the context is, in percent, when the session told it. */
  readonly context: number | undefined;
}

export const NO_FACTS: RowFacts = {
  wait: undefined,
  tool: undefined,
  todos: undefined,
  subagents: 0,
  context: undefined,
};

/** The input keys that name what a call works on, in the order they are looked for. */
const TARGET_KEYS = [
  "file_path",
  "notebook_path",
  "path",
  "command",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
] as const;

/** What a call works on, from its input: a file, a command, a query. */
export function inputTarget(name: string, input: unknown): string | undefined {
  const record = (input ?? {}) as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return shortTarget({ name, target: value });
  }
  return undefined;
}

/** The first line of a question or plan, its Markdown heading marks off. */
function firstLine(text: string): string {
  const line = text.split("\n").find((each) => each.trim() !== "") ?? "";
  return line.replace(/^#+\s*/, "").trim();
}

/**
 * What a Claude or Codex tab's session waits on and does, from its
 * conversation; its running agents from its hooks (`activity`) once they
 * report any, which count its `claude -p` runs too.
 */
export function chatRowFacts(model: ChatModel, activity?: SessionActivity): RowFacts {
  const request = model.permissions[0];
  let wait: RowWait | undefined;
  if (request?.toolName === "AskUserQuestion") {
    const questions = Array.isArray(request.input.questions) ? request.input.questions : [];
    const first = (questions[0] ?? {}) as { question?: unknown };
    wait = {
      kind: "question",
      text: typeof first.question === "string" ? first.question : "",
      count: questions.length,
    };
  } else if (request?.toolName === "ExitPlanMode") {
    const plan = request.input.plan;
    wait = { kind: "plan", text: typeof plan === "string" ? firstLine(plan) : "" };
  } else if (request) {
    const name = request.displayName || request.toolName;
    wait = {
      kind: "permission",
      tool: name,
      target: inputTarget(request.toolName, request.preview?.input ?? request.input),
    };
  }

  let tool: RowFacts["tool"];
  if (model.running) {
    const calls = Object.values(model.tools);
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i] as ToolCall;
      if (call.parentToolUseId || (call.status !== "running" && call.status !== "streaming")) {
        continue;
      }
      const name = call.displayName || call.name;
      tool = { name, target: inputTarget(call.name, call.input) };
      break;
    }
  }

  const todos = todosOf(model.tools);
  return {
    wait,
    tool,
    todos:
      todos.length > 0
        ? { done: todos.filter((todo) => todo.status === "completed").length, total: todos.length }
        : undefined,
    subagents: activity
      ? liveAgents(activity.agents).length
      : chatAgentsOf(model).filter((agent) => agent.status === "running").length,
    context: contextPercent(model),
  };
}

/** How full a chat tab's context is, in percent, once its program told it. */
export function contextPercent(model: ChatModel): number | undefined {
  const context = contextOf(model.contextUsage);
  return context && context.maxTokens > 0
    ? Math.min(100, Math.round((context.totalTokens / context.maxTokens) * 100))
    : undefined;
}

/** What a terminal running Claude waits on and does, from what its hooks report. */
export function hookRowFacts(activity: SessionActivity | undefined): RowFacts {
  if (!activity) return NO_FACTS;
  const ask = activity.asks?.find((each) => each.agentId === undefined) ?? activity.asks?.[0];
  const running = currentTool(activity.tools);
  const todos = activity.todos;
  return {
    wait: ask
      ? {
          kind: "permission",
          tool: ask.tool,
          target: shortTarget({ name: ask.tool, target: ask.target }),
        }
      : undefined,
    tool: running ? { name: running.name, target: shortTarget(running) } : undefined,
    todos:
      todos.length > 0
        ? { done: todos.filter((todo) => todo.status === "completed").length, total: todos.length }
        : undefined,
    subagents: liveAgents(activity.agents).length,
    context: undefined,
  };
}
