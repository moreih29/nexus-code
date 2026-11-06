// The `claude -p` and `codex exec` runs a Claude tab's session starts from
// its Bash tool, as the app records them (main's session activity, by the
// tab's id): shown in the tab beside its subagents, with their state, tools
// and answer.

import { useMemo } from "react";
import type { AgentRun, AgentRunState } from "../../../shared/claude/activity";
import { ipcCallResult } from "../../ipc/client";
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
