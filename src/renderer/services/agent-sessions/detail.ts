import type { AgentRun, SessionActivity } from "../../../shared/claude/activity";
import type { ChatModel, ToolCall } from "../chat/model";
import {
  AGENT_TOOLS,
  changedFilesOf,
  agentsOf as chatAgentsOf,
  editCounts,
  todosOf,
} from "../chat/panel";
import { agentDescription, shortTarget } from "./agents";
import { lastAnswer, lastPrompt } from "./codex-state";
import { contextPercent, inputTarget } from "./rows";

export const STEPS_SHOWN = 6;
export const AGENTS_SHOWN = 8;

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

export interface DetailStep {
  readonly id: string;
  readonly name: string;
  readonly target: string | undefined;
  readonly status: StepStatus;
  readonly added?: number;
  readonly removed?: number;
}

export type DetailAgentStatus = "running" | "asking" | "done" | "failed" | "stopped";

export interface DetailAgent {
  readonly id: string;
  readonly type: string | undefined;
  readonly description: string | undefined;
  readonly status: DetailAgentStatus;
  readonly print: boolean;
  readonly program?: "claude" | "codex";
}

export type DetailTodoStatus = "pending" | "in_progress" | "completed";

export interface DetailTodo {
  readonly id: string;
  readonly text: string;
  readonly status: DetailTodoStatus;
}

export interface DetailFacts {
  readonly steps: readonly DetailStep[];
  readonly agents: readonly DetailAgent[];
  readonly todos: readonly DetailTodo[];
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly mode: string | undefined;
  readonly costUsd: number | undefined;
  readonly context: number | undefined;
  readonly files:
    | { readonly count: number; readonly added?: number; readonly removed?: number }
    | undefined;
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

export function chatDetailFacts(
  model: ChatModel,
  history?: ChatModel | null,
  activity?: SessionActivity,
): DetailFacts {
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
  const agents = activity
    ? hookAgents(activity.agents)
    : chatAgentsOf(told)
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
  const agents = hookAgents(activity.agents);
  const todos = activity.todos.map(
    (todo, index): DetailTodo => ({
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

function hookAgents(agents: readonly AgentRun[]): DetailAgent[] {
  return agents.slice(0, AGENTS_SHOWN).map(
    (agent): DetailAgent => ({
      id: agent.id,
      type: agent.type,
      description: agentDescription(agent),
      status:
        agent.state === "permissionPending"
          ? "asking"
          : agent.state === "completed"
            ? "done"
            : agent.state,
      print: agent.kind === "print",
      ...(agent.program ? { program: agent.program } : {}),
    }),
  );
}
