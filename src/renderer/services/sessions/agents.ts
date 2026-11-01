/**
 * The agents a Claude session runs beside its turn — subagents and
 * `claude -p` runs — as the sessions tab shows them. Pure: read from the
 * activity main records (claude.activity).
 */

import type { AgentRun, SessionActivity, ToolRun } from "../../../shared/claude/activity";
import { type AgentSession, allSessions, type SessionFamily, sessionKey } from "./model";

/** The sessions' activity, by session key. */
export type ActivityByKey = ReadonlyMap<string, SessionActivity>;

export function activityMap(entries: readonly SessionActivity[]): ActivityByKey {
  return new Map(entries.map((entry) => [sessionKey(entry.workspaceId, entry.tabId), entry]));
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

export function endedAgents(agents: readonly AgentRun[]): AgentRun[] {
  return agents.filter((agent) => !isLive(agent));
}

/** How many agents of the family's sessions are running now. */
export function runningAgentCount(family: SessionFamily, activity: ActivityByKey): number {
  let count = 0;
  for (const session of allSessions(family)) {
    count += liveAgents(agentsOf(activity, session.key)).length;
  }
  return count;
}

/** The agents of `sessions`, the live ones first, then the latest ended. */
export function agentsOfSessions(
  sessions: readonly AgentSession[],
  activity: ActivityByKey,
): { session: AgentSession; agent: AgentRun }[] {
  const all = sessions.flatMap((session) =>
    agentsOf(activity, session.key).map((agent) => ({ session, agent })),
  );
  return [
    ...all.filter(({ agent }) => isLive(agent)),
    ...all
      .filter(({ agent }) => !isLive(agent))
      .sort((a, b) => (b.agent.end ?? 0) - (a.agent.end ?? 0)),
  ];
}

/** The agent first waiting on a permission among `agents`, if any. */
export function askingAgent<T extends { agent: AgentRun }>(agents: readonly T[]): T | undefined {
  return agents.find(({ agent }) => agent.state === "permissionPending");
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
