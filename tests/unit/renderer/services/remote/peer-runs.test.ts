import { describe, expect, test } from "bun:test";
import type { ChatRun } from "../../../../../packages/remote-protocol/src";
import {
  agentRunOf,
  peerRunRows,
  RUN_READ_LIVE_MS,
  RUN_READ_SLOW_MS,
  runReadAfter,
} from "../../../../../src/renderer/services/remote/peer-runs";

const run = (over: Partial<ChatRun>): ChatRun => ({
  id: "r1",
  start: 100,
  state: "running",
  toolCount: 0,
  failedCount: 0,
  ...over,
});

describe("another computer's chat's runs", () => {
  test("are rows of its agents, oldest first, keyed apart from its subagents", () => {
    const rows = peerRunRows([
      run({
        id: "r2",
        start: 200,
        prompt: "Summarize\n  the log",
        current: "Bash wc -l",
        last: "Reading",
        toolCount: 3,
        state: "permissionPending",
      }),
      run({ id: "r1", program: "codex", end: 150, state: "completed", model: "gpt-5" }),
    ]);
    expect(rows.map((r) => r.toolUseId)).toEqual(["print:r1", "print:r2"]);
    expect(rows[0]).toMatchObject({
      description: "codex exec",
      subagentType: "codex exec",
      model: "gpt-5",
      status: "completed",
      endedAt: 150,
    });
    expect(rows[1]).toMatchObject({
      description: "Summarize the log",
      subagentType: "claude -p",
      status: "running",
      currentTool: "Bash wc -l",
      lastText: "Reading",
      toolCount: 3,
    });
    expect(rows[1]?.run).toMatchObject({ id: "r2", kind: "print", tools: [] });
  });

  test("a run read whole is the app's own record of one", () => {
    const tools = [{ id: "u1", name: "Read", start: 101, end: 102 }];
    expect(
      agentRunOf(
        run({ tools, messages: [{ at: 1, text: "hi" }], answer: "Done.", sessionId: "s1" }),
      ),
    ).toEqual({
      id: "r1",
      kind: "print",
      start: 100,
      state: "running",
      answer: "Done.",
      tools,
      messages: [{ at: 1, text: "hi" }],
      toolCount: 0,
      failedCount: 0,
      sessionId: "s1",
    });
  });

  test("a run is asked for again while it goes on, unless the other computer refused", () => {
    for (const failure of ["permission-denied", "unsupported"]) {
      expect(runReadAfter(failure, false)).toBeNull();
    }
    expect(runReadAfter(null, false)).toBe(RUN_READ_LIVE_MS);
    expect(runReadAfter("unavailable", false)).toBe(RUN_READ_LIVE_MS);
    expect(runReadAfter("not-found", false)).toBe(RUN_READ_SLOW_MS);
    for (const failure of [null, "unavailable", "not-found"]) {
      expect(runReadAfter(failure, true)).toBeNull();
    }
  });
});
