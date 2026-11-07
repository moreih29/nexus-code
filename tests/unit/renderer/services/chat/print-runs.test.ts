// A Claude or Codex tab's `claude -p` and `codex exec` runs as rows of its
// agents, and which row an agent the hooks tell is.

import { describe, expect, test } from "bun:test";
import type { AgentRow } from "../../../../../src/renderer/services/chat/panel";
import { agentRowKey, printRunRows } from "../../../../../src/renderer/services/chat/print-runs";
import {
  askToShowAgent,
  dropAgentAsk,
  useAgentRevealStore,
} from "../../../../../src/renderer/state/stores/agent-reveal";
import type { AgentRun } from "../../../../../src/shared/claude/activity";

function run(extra: Partial<AgentRun>): AgentRun {
  return {
    id: "print-1",
    kind: "print",
    start: 1_000,
    state: "running",
    tools: [],
    toolCount: 0,
    failedCount: 0,
    ...extra,
  };
}

describe("printRunRows", () => {
  test("gives each run a row of its own, oldest first, keyed apart from Agent calls", () => {
    const rows = printRunRows([
      run({ id: "print-2", start: 2_000, prompt: "Second\n  run", state: "permissionPending" }),
      run({ id: "print-1", start: 1_000, end: 1_500, state: "stopped", answer: "Execution error" }),
    ]);
    expect(rows.map((r) => r.toolUseId)).toEqual(["print:print-1", "print:print-2"]);
    expect(rows[0]).toMatchObject({
      description: "claude -p",
      subagentType: "claude -p",
      status: "stopped",
      startedAt: 1_000,
      endedAt: 1_500,
      lastText: "Execution error",
      teammate: false,
    });
    // Waiting to be allowed a tool, it still runs.
    expect(rows[1]).toMatchObject({ description: "Second run", status: "running" });
    expect(rows[1]?.run?.id).toBe("print-2");
  });

  test("tells the tool a run has running, not one left in the background", () => {
    const [row] = printRunRows([
      run({
        model: "claude-haiku-4-5",
        toolCount: 3,
        tools: [
          { id: "t1", name: "Read", target: "a.ts", start: 1, end: 2 },
          { id: "t2", name: "Bash", target: "npm test", start: 3 },
          { id: "t3", name: "Bash", target: "serve", start: 4, background: true },
        ],
      }),
    ]);
    expect(row).toMatchObject({
      currentTool: "Bash npm test",
      toolCount: 3,
      model: "claude-haiku-4-5",
    });
  });

  test("tells what a running run wrote last, and its answer once it ended", () => {
    const messages = [
      { at: 1, text: "Looking." },
      { at: 2, text: "Running the tests." },
    ];
    expect(printRunRows([run({ messages })])[0]?.lastText).toBe("Running the tests.");
    expect(printRunRows([run({ messages, answer: "Done." })])[0]?.lastText).toBe("Done.");
  });

  test("names a codex exec run as such, and where its model is served", () => {
    const [row] = printRunRows([
      run({ program: "codex", model: "gpt-6-luna", endpoint: "gw.example.com" }),
    ]);
    expect(row).toMatchObject({
      description: "codex exec",
      subagentType: "codex exec",
      model: "gpt-6-luna",
      endpoint: "gw.example.com",
    });
  });
});

describe("agentRowKey", () => {
  const subagent: AgentRow = {
    toolUseId: "toolu_1",
    taskId: "a8dbbdc15d04de05a",
    description: "Count the files",
    status: "running",
    toolCount: 0,
    teammate: false,
  };
  const rows = [subagent, ...printRunRows([run({ id: "print-3" })])];

  test("a run by its id, a subagent by its task", () => {
    expect(agentRowKey(rows, { id: "print-3", kind: "print" })).toBe("print:print-3");
    expect(agentRowKey(rows, { id: "a8dbbdc15d04de05a", kind: "subagent" })).toBe("toolu_1");
  });

  test("none for an agent the tab does not have", () => {
    expect(agentRowKey(rows, { id: "print-9", kind: "print" })).toBeUndefined();
    // A subagent's id is not a run's.
    expect(agentRowKey(rows, { id: "print-3", kind: "subagent" })).toBeUndefined();
  });
});

describe("agent asks", () => {
  test("wait by the tab until dropped", () => {
    askToShowAgent("tab-1", run({ id: "print-3" }));
    askToShowAgent("tab-2", { id: "a1", kind: "subagent" });
    expect(useAgentRevealStore.getState().asked).toEqual({
      "tab-1": { id: "print-3", kind: "print" },
      "tab-2": { id: "a1", kind: "subagent" },
    });
    dropAgentAsk("tab-1");
    expect(useAgentRevealStore.getState().asked).toEqual({
      "tab-2": { id: "a1", kind: "subagent" },
    });
    dropAgentAsk("tab-2");
    expect(useAgentRevealStore.getState().asked).toEqual({});
  });
});
