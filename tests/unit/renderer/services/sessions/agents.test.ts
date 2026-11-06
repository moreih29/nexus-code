/**
 * The agents a Claude session runs, as the sessions tab reads them from the
 * activity main records.
 */
import { describe, expect, it } from "bun:test";
import { resolveSelection } from "../../../../../src/renderer/components/sessions/selection";
import {
  activityMap,
  agentFlow,
  currentTool,
  rowAgents,
  runMessages,
  sameActivityMap,
  shortTarget,
  toolLine,
} from "../../../../../src/renderer/services/sessions/agents";
import type {
  AgentSession,
  SessionFamily,
} from "../../../../../src/renderer/services/sessions/model";
import type { AgentRun, SessionActivity, ToolRun } from "../../../../../src/shared/claude/activity";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const W = "w";

function run(id: string, end?: number, state: AgentRun["state"] = "running"): AgentRun {
  return {
    id,
    kind: "subagent",
    start: 0,
    ...(end !== undefined ? { end } : {}),
    state,
    tools: [],
    toolCount: 0,
    failedCount: 0,
  };
}

function activity(tabId: string, agents: AgentRun[]): SessionActivity {
  return {
    workspaceId: W,
    tabId,
    tools: [],
    toolCount: 0,
    failedCount: 0,
    files: [],
    todos: [],
    agents,
  };
}

const session = (tabId: string) =>
  ({ key: `${W}:${tabId}`, workspaceId: W, tabId, phase: "running" }) as AgentSession;

const family: SessionFamily = {
  root: { id: W } as WorkspaceMeta,
  worktrees: [
    {
      workspace: { id: W } as WorkspaceMeta,
      isRoot: true,
      branch: undefined,
      sessions: [session("a"), session("b")],
    },
  ],
};

describe("agents", () => {
  const map = activityMap([
    activity("a", [run("a1"), run("a2", 50, "completed")]),
    activity("b", [run("b1"), run("b2", 90, "stopped")]),
  ]);

  it("tells a tool by its name and a short target", () => {
    const tool = (name: string, target?: string, end?: number): ToolRun => ({
      id: name,
      name,
      start: 0,
      ...(target !== undefined ? { target } : {}),
      ...(end !== undefined ? { end } : {}),
    });
    expect(shortTarget(tool("Edit", "src/a/b.ts"))).toBe("b.ts");
    expect(toolLine(tool("Bash", "bun test\nmore"))).toBe("Bash bun test");
    expect(toolLine(tool("TodoWrite"))).toBe("TodoWrite");
    expect(currentTool([tool("Read", "a", 1), tool("Grep", "x"), tool("Glob", "y", 2)])?.name).toBe(
      "Grep",
    );
  });

  it("compares reads", () => {
    expect(sameActivityMap(map, activityMap([...map.values()]))).toBe(true);
    expect(sameActivityMap(map, activityMap([activity("a", [])]))).toBe(false);
  });

  it("keeps an agent selection while its record lasts, else shows its session", () => {
    const picked = { kind: "agent", key: `${W}:a`, agentId: "a1" } as const;
    expect(resolveSelection(family, picked, () => true)).toBe(picked);
    expect(resolveSelection(family, picked, () => false)).toEqual({
      kind: "session",
      key: `${W}:a`,
    });
  });
});

describe("the agents under a conversation's row", () => {
  it("are those still running, and the one selected", () => {
    const agents = [run("a1"), run("a2", 5, "completed"), run("a3", 6, "completed")];
    expect(rowAgents(agents, undefined).map((agent) => agent.id)).toEqual(["a1"]);
    expect(rowAgents(agents, "a3").map((agent) => agent.id)).toEqual(["a1", "a3"]);
  });
});

describe("a run's messages", () => {
  const said = (at: number, text: string) => ({ at, text });

  it("leave out its answer, shown on its own", () => {
    const messages = [said(1, "Looking."), said(5, "Done.")];
    const ended = { ...run("p1", 6, "completed"), kind: "print" as const, messages };
    expect(runMessages({ ...ended, answer: "Done." })).toEqual([said(1, "Looking.")]);
    expect(runMessages({ ...ended, answer: "Something else." })).toEqual(messages);
    expect(runMessages(run("p2"))).toEqual([]);
  });

  it("go with its tools in order, a message before the tool told with it", () => {
    const tool = (id: string, start: number): ToolRun => ({ id, name: "Bash", start });
    const entries = agentFlow(
      [tool("t1", 2), tool("t2", 5)],
      [said(1, "Looking."), said(5, "Running the tests.")],
    );
    expect(entries.map((entry) => entry.key)).toEqual(["message:0", "t1", "message:1", "t2"]);
  });
});
