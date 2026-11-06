/**
 * What the agents tab's detail panel tells of a conversation beside its
 * state: the calls it ran last, the subagents it runs, its to-do list, and
 * what it runs on (model, effort, permission mode, context, cost, the files
 * it changed). A chat tab tells it from its conversation, a terminal running
 * Claude from what its hooks report. Pure.
 */

import type { SessionActivity } from "../../../shared/claude/activity";
import type { ChatModel, ToolCall } from "../chat/model";
import {
  AGENT_TOOLS,
  changedFilesOf,
  agentsOf as chatAgentsOf,
  editCounts,
  todosOf,
} from "../chat/panel";
import { shortTarget } from "./agents";
import { lastAnswer, lastPrompt } from "./codex-state";
import { contextPercent, inputTarget } from "./rows";

/** How many of the latest calls the panel lists. */
export const STEPS_SHOWN = 6;
/** How many subagents the panel lists, the latest. */
export const AGENTS_SHOWN = 8;

/**
 * Calls the panel tells elsewhere: the to-dos in their list, the subagents in
 * theirs, a question or a plan in its card.
 */
const TOLD_ELSEWHERE = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "AskUserQuestion",
  "ExitPlanMode",
  ...AGENT_TOOLS,
]);

export type StepStatus = "running" | "done" | "failed" | "stopped";

/** A call the conversation ran, as the panel lists it. */
export interface DetailStep {
  readonly id: string;
  readonly name: string;
  readonly target: string | undefined;
  readonly status: StepStatus;
  /** For a done edit: the lines it added and removed. */
  readonly added?: number;
  readonly removed?: number;
}

export type DetailAgentStatus = "running" | "asking" | "done" | "failed" | "stopped";

export interface DetailAgent {
  readonly id: string;
  /** Its type, as "Explore"; absent when the conversation did not say. */
  readonly type: string | undefined;
  readonly description: string | undefined;
  readonly status: DetailAgentStatus;
  /** A `claude -p` run the session started, rather than a subagent. */
  readonly print: boolean;
}

export type DetailTodoStatus = "pending" | "in_progress" | "completed";

export interface DetailTodo {
  readonly id: string;
  /** How it reads: while worked on, its active form when it has one. */
  readonly text: string;
  readonly status: DetailTodoStatus;
}

export interface DetailFacts {
  readonly steps: readonly DetailStep[];
  readonly agents: readonly DetailAgent[];
  readonly todos: readonly DetailTodo[];
  /** The model the conversation runs, as its program names it. */
  readonly model: string | undefined;
  readonly effort: string | undefined;
  /** Its permission mode, by its program's own name for it. */
  readonly mode: string | undefined;
  readonly costUsd: number | undefined;
  /** How full its context is, in percent. */
  readonly context: number | undefined;
  /** The files it changed: how many, and their lines when it tells them. */
  readonly files:
    | { readonly count: number; readonly added?: number; readonly removed?: number }
    | undefined;
  /** Its last prompt and the answer to it, when the conversation tells them itself. */
  readonly prompt: string | undefined;
  readonly answer: string | undefined;
}

export const NO_DETAIL: DetailFacts = {
  steps: [],
  agents: [],
  todos: [],
  model: undefined,
  effort: undefined,
  mode: undefined,
  costUsd: undefined,
  context: undefined,
  files: undefined,
  prompt: undefined,
  answer: undefined,
};

function chatStepStatus(call: ToolCall): StepStatus {
  switch (call.status) {
    case "streaming":
    case "running":
      return "running";
    case "done":
      return "done";
    case "error":
      return "failed";
    default:
      return "stopped";
  }
}

function todoStatus(status: string): DetailTodoStatus {
  return status === "completed" || status === "in_progress" ? status : "pending";
}

/**
 * What a Claude or Codex tab's conversation tells the panel. A tab opened
 * again shows its earlier conversation (`history`) until it is sent more.
 */
export function chatDetailFacts(model: ChatModel, history?: ChatModel | null): DetailFacts {
  const told = model.items.length === 0 && history ? history : model;
  const steps = Object.values(told.tools)
    .filter((call) => !call.parentToolUseId && !TOLD_ELSEWHERE.has(call.name))
    .slice(-STEPS_SHOWN)
    .map((call): DetailStep => {
      const counts = editCounts(call);
      return {
        id: call.id,
        name: call.displayName || call.name,
        target: inputTarget(call.name, call.input),
        status: chatStepStatus(call),
        ...(counts ?? {}),
      };
    });
  const agents = chatAgentsOf(told)
    .slice(-AGENTS_SHOWN)
    .map(
      (agent): DetailAgent => ({
        id: agent.toolUseId,
        type: agent.subagentType,
        description: agent.description || undefined,
        status: agent.status === "completed" ? "done" : agent.status,
        print: false,
      }),
    );
  const todos = todosOf(told.tools).map(
    (todo): DetailTodo => ({ id: todo.id, text: todo.content, status: todoStatus(todo.status) }),
  );
  const changed = changedFilesOf(told.tools);
  return {
    steps,
    agents,
    todos,
    model: model.model ?? told.model,
    effort: model.effort ?? told.effort,
    mode: model.permissionMode ?? told.permissionMode,
    costUsd: model.costUsd ?? told.costUsd,
    context: contextPercent(model) ?? contextPercent(told),
    files:
      changed.length > 0
        ? {
            count: changed.length,
            added: changed.reduce((sum, file) => sum + file.added, 0),
            removed: changed.reduce((sum, file) => sum + file.removed, 0),
          }
        : undefined,
    prompt: lastPrompt(told),
    answer: lastAnswer(told),
  };
}

/** What a terminal running Claude tells the panel, from its hooks. */
export function hookDetailFacts(activity: SessionActivity | undefined): DetailFacts {
  if (!activity) return NO_DETAIL;
  const steps = activity.tools
    .filter((tool) => !TOLD_ELSEWHERE.has(tool.name))
    .slice(-STEPS_SHOWN)
    .map(
      (tool): DetailStep => ({
        id: tool.id,
        name: tool.name,
        target: shortTarget(tool),
        status:
          tool.end === undefined
            ? "running"
            : tool.denied
              ? "stopped"
              : tool.failed
                ? "failed"
                : "done",
      }),
    );
  // The hooks keep the running agents first, then the ended ones, the latest first.
  const agents = activity.agents.slice(0, AGENTS_SHOWN).map(
    (agent): DetailAgent => ({
      id: agent.id,
      type: agent.type,
      description: agent.description,
      status:
        agent.state === "permissionPending"
          ? "asking"
          : agent.state === "completed"
            ? "done"
            : agent.state,
      print: agent.kind === "print",
    }),
  );
  const todos = activity.todos.map(
    (todo, index): DetailTodo => ({
      // A TodoWrite list has no ids, and may say the same twice; it is
      // replaced whole, never reordered.
      id: todo.id ?? String(index),
      text: todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content,
      status: todo.status,
    }),
  );
  return {
    ...NO_DETAIL,
    steps,
    agents,
    todos,
    files: activity.files.length > 0 ? { count: activity.files.length } : undefined,
  };
}
