// The `claude -p` and `codex exec` runs a Claude or Codex tab's session
// starts from its commands, as the app records them (main's session
// activity, by the tab's id): shown in the tab beside its subagents, with
// their state, tools and answer; and the agent the agents tab asks the tab
// to show.

import { useEffect, useMemo } from "react";
import type { AgentRun, AgentRunState } from "../../../shared/claude/activity";
import { ipcCallResult } from "../../ipc/client";
import { type AgentRef, dropAgentAsk, useAgentRevealStore } from "../../state/stores/agent-reveal";
import { sessionKey } from "../sessions/model";
import { useSessionActivity } from "../sessions/use-family";
import type { AgentRow, AgentStatus } from "./panel";

/** What a run's row is keyed by among the tab's agents, apart from Agent calls. */
const RUN_KEY_PREFIX = "print:";

const NO_RUNS: readonly AgentRun[] = [];

/** The tab's runs, latest first, polled while `enabled`. */
export function usePrintRuns(
  workspaceId: string,
  tabId: string,
  enabled: boolean,
): readonly AgentRun[] {
  const ids = useMemo(() => [workspaceId], [workspaceId]);
  const activity = useSessionActivity(ids, enabled);
  const agents = activity.get(sessionKey(workspaceId, tabId))?.agents;
  return useMemo(() => agents?.filter((a) => a.kind === "print") ?? NO_RUNS, [agents]);
}

function statusOf(state: AgentRunState): AgentStatus {
  return state === "permissionPending" ? "running" : state;
}

/** The tab's runs as rows of its agents, oldest first, as its subagents are. */
export function printRunRows(runs: readonly AgentRun[]): AgentRow[] {
  return [...runs]
    .sort((a, b) => a.start - b.start)
    .map((run) => {
      const tool = [...run.tools].reverse().find((t) => t.end === undefined && !t.background);
      const program = run.program === "codex" ? "codex exec" : "claude -p";
      return {
        toolUseId: `${RUN_KEY_PREFIX}${run.id}`,
        description: oneLine(run.prompt ?? run.description ?? "") || program,
        subagentType: program,
        model: run.model,
        endpoint: run.endpoint,
        status: statusOf(run.state),
        startedAt: run.start,
        endedAt: run.end,
        toolCount: run.toolCount,
        currentTool: tool ? (tool.target ? `${tool.name} ${tool.target}` : tool.name) : undefined,
        lastText: run.answer,
        prompt: run.prompt,
        teammate: false,
        run,
      };
    });
}

/**
 * The key of an agent the app's hooks tell among the tab's agents: a run by
 * its id, a subagent by its task, whose id is the hooks' agent id.
 */
export function agentRowKey(rows: readonly AgentRow[], agent: AgentRef): string | undefined {
  const key = agent.kind === "print" ? `${RUN_KEY_PREFIX}${agent.id}` : undefined;
  return rows.find((row) => (key ? row.toolUseId === key : row.taskId === agent.id))?.toolUseId;
}

/**
 * Shows the agent the agents tab asked the tab to show, once it is among
 * the tab's agents (askToShowAgent).
 */
export function useAgentAsk(
  tabId: string,
  rows: readonly AgentRow[],
  show: (toolUseId: string) => void,
): void {
  const asked = useAgentRevealStore((state) => state.asked[tabId]);
  useEffect(() => {
    if (!asked) return;
    const key = agentRowKey(rows, asked);
    if (key === undefined) return;
    show(key);
    dropAgentAsk(tabId);
  }, [tabId, asked, rows, show]);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Stops a running run, as an interrupt would; false when it no longer can be. */
export async function stopPrintRun(
  workspaceId: string,
  tabId: string,
  agentId: string,
): Promise<boolean> {
  const result = await ipcCallResult("claude", "stopPrintRun", { workspaceId, tabId, agentId });
  return result.ok && result.value;
}
