import type {
  AgentMessage,
  AgentRun,
  SessionActivity,
  ToolRun,
} from "../../../shared/claude/activity";
import { sessionKey } from "./model";

export type ActivityByKey = ReadonlyMap<string, SessionActivity>;

export function activityMap(entries: readonly SessionActivity[]): ActivityByKey {
  return new Map(entries.map((entry) => [sessionKey(entry.workspaceId, entry.tabId), entry]));
}

export function agentDescription(agent: AgentRun): string | undefined {
  if (agent.description !== undefined) return agent.description;
  if (agent.kind !== "print") return undefined;
  return agent.prompt?.replace(/\s+/g, " ").trim() || undefined;
}

export function runMessages(agent: AgentRun): readonly AgentMessage[] {
  const messages = agent.messages ?? [];
  const last = messages[messages.length - 1];
  return last !== undefined && last.text === agent.answer ? messages.slice(0, -1) : messages;
}

export type FlowEntry =
  | { readonly key: string; readonly at: number; readonly tool: ToolRun }
  | { readonly key: string; readonly at: number; readonly message: AgentMessage };

export function agentFlow(
  tools: readonly ToolRun[],
  messages: readonly AgentMessage[],
): FlowEntry[] {
  const entries: FlowEntry[] = [
    ...messages.map((message, i) => ({ key: `message:${i}`, at: message.at, message })),
    ...tools.map((tool) => ({ key: tool.id, at: tool.start, tool })),
  ];
  return entries.sort((a, b) => a.at - b.at);
}

export function isLive(agent: AgentRun): boolean {
  return agent.end === undefined;
}

export function agentsOf(activity: ActivityByKey, key: string): readonly AgentRun[] {
  return activity.get(key)?.agents ?? [];
}

export function liveAgents(agents: readonly AgentRun[]): AgentRun[] {
  return agents.filter(isLive);
}

export function rowAgents(agents: readonly AgentRun[], selectedId: string | undefined): AgentRun[] {
  return agents.filter((agent) => isLive(agent) || agent.id === selectedId);
}

export function currentTool(tools: readonly ToolRun[]): ToolRun | undefined {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (tool && tool.end === undefined && !tool.background) return tool;
  }
  return undefined;
}

export function shortTarget(tool: Pick<ToolRun, "name" | "target">): string | undefined {
  const target = tool.target;
  if (target === undefined) return undefined;
  const line = target.split("\n")[0] ?? target;
  if (PATH_TOOLS.has(tool.name)) return line.split(/[\\/]/).pop() || line;
  return line;
}

const PATH_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]);

export function toolLine(tool: Pick<ToolRun, "name" | "target">): string {
  const target = shortTarget(tool);
  return target ? `${tool.name} ${target}` : tool.name;
}

export function findAgent(
  activity: ActivityByKey,
  key: string,
  agentId: string,
): AgentRun | undefined {
  return agentsOf(activity, key).find((agent) => agent.id === agentId);
}

export function sameActivityMap(a: ActivityByKey, b: ActivityByKey): boolean {
  if (a.size !== b.size) return false;
  for (const [key, x] of a) {
    const y = b.get(key);
    if (y === undefined || JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}
