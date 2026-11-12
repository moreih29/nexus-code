/**
 * The agents a Claude session runs beside its turn — subagents and
 * `claude -p` runs — as the agent list shows them. Pure: read from the
 * activity main records (claude.activity).
 */

import type {
  AgentMessage,
  AgentRun,
  SessionActivity,
  ToolRun,
} from "../../../shared/claude/activity";
import { sessionKey } from "./model";

/** The sessions' activity, by session key. */
export type ActivityByKey = ReadonlyMap<string, SessionActivity>;

export function activityMap(entries: readonly SessionActivity[]): ActivityByKey {
  return new Map(entries.map((entry) => [sessionKey(entry.workspaceId, entry.tabId), entry]));
}

/**
 * What the agent was started to do: its Agent call's description, or what
 * the command that started a `claude -p` or `codex exec` run was said to do;
 * else a run's prompt, on one line, as a Codex tab's commands tell no more.
 */
export function agentDescription(agent: AgentRun): string | undefined {
  if (agent.description !== undefined) return agent.description;
  if (agent.kind !== "print") return undefined;
  return agent.prompt?.replace(/\s+/g, " ").trim() || undefined;
}

/**
 * What a run wrote between its tools, oldest first: without its answer,
 * shown on its own once it ended.
 */
export function runMessages(agent: AgentRun): readonly AgentMessage[] {
  const messages = agent.messages ?? [];
  const last = messages[messages.length - 1];
  return last !== undefined && last.text === agent.answer ? messages.slice(0, -1) : messages;
}

/** A step of what an agent did: a tool it ran, or what it wrote. */
export type FlowEntry =
  | { readonly key: string; readonly at: number; readonly tool: ToolRun }
  | { readonly key: string; readonly at: number; readonly message: AgentMessage };

/**
 * What an agent did, in order, as its session's own turn reads: its tools
 * and what it wrote between them. A message told with a tool was written
 * before it.
 */
export function agentFlow(
  tools: readonly ToolRun[],
  messages: readonly AgentMessage[],
): FlowEntry[] {
  const entries: FlowEntry[] = [
    ...messages.map((message, i) => ({ key: `message:${i}`, at: message.at, message })),
    ...tools.map((tool) => ({ key: tool.id, at: tool.start, tool })),
  ];
  // Stable: at the same time, the message stays before the tool.
  return entries.sort((a, b) => a.at - b.at);
}

/** Whether the agent still runs (or waits on a permission). */
export function isLive(agent: AgentRun): boolean {
  return agent.end === undefined;
}

/** The agents of a session: the live ones first, as main lists them. */
export function agentsOf(activity: ActivityByKey, key: string): readonly AgentRun[] {
  return activity.get(key)?.agents ?? [];
}

export function liveAgents(agents: readonly AgentRun[]): AgentRun[] {
  return agents.filter(isLive);
}

/**
 * The agents a conversation's row lists under it: those still running, and
 * the one selected, so where it belongs shows in the list.
 */
export function rowAgents(agents: readonly AgentRun[], selectedId: string | undefined): AgentRun[] {
  return agents.filter((agent) => isLive(agent) || agent.id === selectedId);
}

/** A tool still running, the latest of them. */
export function currentTool(tools: readonly ToolRun[]): ToolRun | undefined {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (tool && tool.end === undefined && !tool.background) return tool;
  }
  return undefined;
}

/** A path's last part, a command's first line: a target short enough for a line. */
export function shortTarget(tool: Pick<ToolRun, "name" | "target">): string | undefined {
  const target = tool.target;
  if (target === undefined) return undefined;
  const line = target.split("\n")[0] ?? target;
  if (PATH_TOOLS.has(tool.name)) return line.split(/[\\/]/).pop() || line;
  return line;
}

const PATH_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** A tool as a line: its name and what it works on. */
export function toolLine(tool: Pick<ToolRun, "name" | "target">): string {
  const target = shortTarget(tool);
  return target ? `${tool.name} ${target}` : tool.name;
}

/** Whether an agent selection still names an agent of the session. */
export function findAgent(
  activity: ActivityByKey,
  key: string,
  agentId: string,
): AgentRun | undefined {
  return agentsOf(activity, key).find((agent) => agent.id === agentId);
}

/** Whether two reads of the sessions' activity tell the same. */
export function sameActivityMap(a: ActivityByKey, b: ActivityByKey): boolean {
  if (a.size !== b.size) return false;
  for (const [key, x] of a) {
    const y = b.get(key);
    if (y === undefined || JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}
