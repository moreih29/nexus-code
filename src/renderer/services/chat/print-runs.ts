import { useEffect, useMemo } from "react";
import type { AgentRun, AgentRunState } from "../../../shared/claude/activity";
import { ipcCallResult } from "../../ipc/client";
import { type AgentRef, dropAgentAsk, useAgentRevealStore } from "../../state/stores/agent-reveal";
import { sessionKey } from "../agent-sessions/model";
import { useSessionActivity } from "../agent-sessions/use-family";
import type { AgentRow, AgentStatus } from "./panel";

const RUN_KEY_PREFIX = "print:";

const NO_RUNS: readonly AgentRun[] = [];

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
        lastText: run.answer ?? run.messages?.[run.messages.length - 1]?.text,
        prompt: run.prompt,
        teammate: false,
        run,
      };
    });
}

export function agentRowKey(rows: readonly AgentRow[], agent: AgentRef): string | undefined {
  const key = agent.kind === "print" ? `${RUN_KEY_PREFIX}${agent.id}` : undefined;
  return rows.find((row) => (key ? row.toolUseId === key : row.taskId === agent.id))?.toolUseId;
}

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

export async function stopPrintRun(
  workspaceId: string,
  tabId: string,
  agentId: string,
): Promise<boolean> {
  const result = await ipcCallResult("claude", "stopPrintRun", { workspaceId, tabId, agentId });
  return result.ok && result.value;
}
