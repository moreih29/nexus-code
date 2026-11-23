import { describe, expect, test } from "bun:test";
import type { ChatItem, TaskInfo, ToolCall } from "../../../../../src/renderer/services/chat/model";
import type { AgentRow } from "../../../../../src/renderer/services/chat/panel";
import {
  activityOf,
  activityParts,
  canBackground,
  heldBack,
  jobStatus,
  newestEndedFirst,
  searchActivity,
  WAITED_CALL_DELAY_MS,
} from "../../../../../src/renderer/services/chat/running";

function call(id: string, name: string, input: unknown, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name, input, status: "running", parentToolUseId: null, ...over };
}

function agent(toolUseId: string, over: Partial<AgentRow> = {}): AgentRow {
  return {
    toolUseId,
    description: toolUseId,
    status: "running",
    toolCount: 0,
    teammate: false,
    ...over,
  };
}

function job(taskId: string, over: Partial<TaskInfo> = {}): TaskInfo {
  return { taskId, type: "local_bash", description: taskId, status: "running", ...over };
}

function said(at: number, ...toolUseIds: string[]): ChatItem {
  return {
    kind: "assistant",
    key: `a${at}`,
    messageId: `m${at}`,
    blocks: toolUseIds.map((toolUseId) => ({ type: "tool" as const, toolUseId })),
    at,
  };
}

describe("canBackground", () => {
  test("a command or a subagent the main thread waits on", () => {
    expect(canBackground(call("b", "Bash", { command: "sleep 9" }))).toBe(true);
    expect(canBackground(call("a", "Agent", { prompt: "x" }))).toBe(true);
    expect(canBackground(call("b", "Bash", { command: "x", run_in_background: true }))).toBe(false);
    expect(canBackground(call("b", "Bash", {}, { status: "done" }))).toBe(false);
    expect(canBackground(call("b", "Bash", {}, { parentToolUseId: "a" }))).toBe(false);
    expect(canBackground(call("r", "Read", { file_path: "/x" }))).toBe(false);
  });
});

describe("activityOf", () => {
  const tools: Record<string, ToolCall> = {
    sync: call("sync", "Agent", { description: "write tests" }),
    async: call("async", "Agent", { run_in_background: true }, { status: "done" }),
    fg: call("fg", "Bash", { command: "bun run test:e2e\n--bail", description: "" }),
    asked: call("asked", "Bash", { command: "rm -rf build", description: "Clean the build" }),
    bg: call("bg", "Bash", { command: "bun dev", run_in_background: true }),
    sent: call("sent", "Bash", { command: "make" }),
  };
  const items = [said(100, "sync", "async"), said(200, "fg", "asked"), said(300, "bg", "sent")];
  const agents = [
    agent("async", { startedAt: 110, description: "look around" }),
    agent("sync", { startedAt: 105, taskId: "t-sync" }),
    agent("done", { status: "completed", startedAt: 10, endedAt: 50 }),
    agent("print:r1", {
      status: "failed",
      startedAt: 20,
      endedAt: 70,
      run: { id: "r1" } as AgentRow["run"],
    }),
  ];
  const jobs = [
    job("j-bg", { toolUseId: "bg", startedAt: 300 }),
    job("j-sent", { toolUseId: "sent", startedAt: 310 }),
    job("j-old", { status: "killed", startedAt: 5, endedAt: 60 }),
  ];
  const activity = activityOf({
    agents,
    jobs,
    tools,
    items,
    waiting: new Set(["asked"]),
  });

  test("lists what the turn waits on first, then what runs beside it, each as it started", () => {
    expect(activity.running.map((row) => row.key)).toEqual([
      "sync",
      "call:fg",
      "call:asked",
      "job:j-sent",
      "async",
      "job:j-bg",
    ]);
  });

  test("a call the turn waits on can go to the background, but not while it asks the user", () => {
    const byKey = new Map(activity.running.map((row) => [row.key, row]));
    expect(byKey.get("sync")).toMatchObject({ kind: "agent", waited: true, foreground: "sync" });
    expect(byKey.get("call:fg")).toMatchObject({
      kind: "command",
      waited: true,
      foreground: "fg",
      background: false,
      description: "bun run test:e2e",
      startedAt: 200,
    });
    expect(byKey.get("call:asked")).toMatchObject({ waited: true, description: "Clean the build" });
    expect(byKey.get("call:asked")?.foreground).toBeUndefined();
    expect(byKey.get("job:j-sent")).toMatchObject({ waited: true, foreground: "sent" });
    expect(activity.running.some((row) => row.key === "call:sent")).toBe(false);
  });

  test("what runs beside the turn is in the background", () => {
    const byKey = new Map(activity.running.map((row) => [row.key, row]));
    expect(byKey.get("async")).toMatchObject({ background: true, waited: false });
    expect(byKey.get("async")?.foreground).toBeUndefined();
    expect(byKey.get("job:j-bg")).toMatchObject({ background: true, kind: "command" });
  });

  test("lists what ended, the newest first, with its kind", () => {
    expect(activity.ended.map((row) => [row.key, row.kind, row.status])).toEqual([
      ["print:r1", "run", "failed"],
      ["job:j-old", "command", "stopped"],
      ["done", "agent", "completed"],
    ]);
  });

  test("no call is waited on once the turn ended", () => {
    const ended = activityOf({ agents: [], jobs: [], tools, items, turnRunning: false });
    expect(ended.running).toEqual([]);
  });
});

describe("newestEndedFirst", () => {
  test("by when each ended, else began; those with no time last, the later listed first", () => {
    const rows = [
      { key: "a", startedAt: 1, endedAt: 5 },
      { key: "b" },
      { key: "c", startedAt: 9 },
      { key: "d" },
      { key: "e", startedAt: 2, endedAt: 7 },
    ];
    expect(newestEndedFirst(rows).map((row) => row.key)).toEqual(["c", "e", "a", "d", "b"]);
  });
});

describe("jobStatus", () => {
  test("killed is stopped", () => {
    expect(jobStatus("killed")).toBe("stopped");
    expect(jobStatus("completed")).toBe("completed");
    expect(jobStatus("failed")).toBe("failed");
    expect(jobStatus("running")).toBe("running");
  });
});

describe("searchActivity", () => {
  const { ended } = activityOf({
    agents: [
      agent("x", {
        status: "completed",
        description: "Payment module refactor",
        subagentType: "Plan",
      }),
      agent("y", { status: "failed", description: "Find why e2e fails", model: "haiku" }),
    ],
    jobs: [job("z", { status: "completed", description: "bun run lint" })],
    tools: {},
    items: [],
  });

  test("keeps the rows with every word, whatever their case", () => {
    expect(searchActivity(ended, "").map((row) => row.key)).toEqual(ended.map((row) => row.key));
    expect(searchActivity(ended, "PAYMENT").map((row) => row.key)).toEqual(["x"]);
    expect(searchActivity(ended, "plan refactor").map((row) => row.key)).toEqual(["x"]);
    expect(searchActivity(ended, "haiku").map((row) => row.key)).toEqual(["y"]);
    expect(searchActivity(ended, "local_bash").map((row) => row.key)).toEqual(["job:z"]);
    expect(searchActivity(ended, "nothing")).toEqual([]);
  });
});

describe("activityParts", () => {
  test("puts the commands in one part, the subagents and runs in the other, each in order", () => {
    const activity = activityOf({
      agents: [
        agent("a1", { startedAt: 1 }),
        agent("r1", { startedAt: 2, run: { id: "run-1" } as AgentRow["run"] }),
        agent("a0", { status: "completed", endedAt: 5 }),
      ],
      jobs: [job("j1", { startedAt: 3 }), job("j0", { status: "completed", endedAt: 6 })],
      tools: {},
      items: [],
    });
    const { commands, agents } = activityParts(activity);
    expect(commands.running.map((row) => row.key)).toEqual(["job:j1"]);
    expect(commands.ended.map((row) => row.key)).toEqual(["job:j0"]);
    expect(agents.running.map((row) => row.key)).toEqual(["a1", "r1"]);
    expect(agents.ended.map((row) => row.key)).toEqual(["a0"]);
  });
});

describe("heldBack", () => {
  const tools: Record<string, ToolCall> = {
    fresh: call("fresh", "Bash", { command: "ls" }),
    old: call("old", "Bash", { command: "bun test" }),
    sub: call("sub", "Agent", { description: "look" }),
  };
  const now = 100_000;
  const activity = activityOf({
    agents: [agent("sub", { startedAt: now })],
    jobs: [job("j1", { startedAt: now })],
    tools,
    items: [said(now - 1_000, "fresh"), said(now - WAITED_CALL_DELAY_MS, "old")],
  });

  test("keeps a command the turn waits on back until it has run a moment, nothing else", () => {
    const { shown, nextAt } = heldBack(activity.running, now);
    expect(shown.map((row) => row.key).sort()).toEqual(["call:old", "job:j1", "sub"]);
    expect(nextAt).toBe(now - 1_000 + WAITED_CALL_DELAY_MS);
    const later = heldBack(activity.running, now + 2_000);
    expect(later.shown).toBe(activity.running);
    expect(later.nextAt).toBeUndefined();
  });

  test("counts one whose message tells no time from when it was first seen", () => {
    const rows = activityOf({
      agents: [],
      jobs: [],
      tools: { fresh: tools.fresh as ToolCall },
      items: [],
    }).running;
    expect(heldBack(rows, now).shown).toHaveLength(0);
    const seen = new Map([["call:fresh", now - WAITED_CALL_DELAY_MS]]);
    expect(heldBack(rows, now, seen).shown).toHaveLength(1);
  });
});
