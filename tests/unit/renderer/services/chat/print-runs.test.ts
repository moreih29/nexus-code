// A Claude tab's `claude -p` runs as rows of its agents.

import { describe, expect, test } from "bun:test";
import { printRunRows } from "../../../../../src/renderer/services/chat/print-runs";
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
});
