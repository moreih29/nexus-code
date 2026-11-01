import { beforeEach, describe, expect, test } from "bun:test";
import {
  describeTool,
  SessionActivityLog,
} from "../../../../src/main/features/claude/session-activity";
import type { AgentRun } from "../../../../src/shared/claude/activity";
import { ENDED_AGENTS_KEPT, SESSION_TOOLS_KEPT } from "../../../../src/shared/claude/activity";

const WS = "ws-1";
const TAB = "tab-1";
const CWD = "/repo";

let clock: number;
let log: SessionActivityLog;
let changes: AgentRun[];

beforeEach(() => {
  clock = 1_000;
  log = new SessionActivityLog(() => clock);
  changes = [];
  log.onAgentChange((_ws, _tab, agent) => changes.push(agent));
});

function hook(subcommand: string, payload: Record<string, unknown> = {}): void {
  log.noteHook(WS, TAB, subcommand, { cwd: CWD, ...payload });
}

function activity() {
  const found = log.get(WS, TAB);
  if (!found) throw new Error("no activity");
  return found;
}

describe("tools", () => {
  test("a tool runs from its PreToolUse to its PostToolUse", () => {
    hook("user-prompt-submit", { prompt: "go" });
    hook("pre-tool-use", {
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: "bun test\nmore", description: "Run tests" },
    });
    expect(activity().tools).toEqual([
      { id: "t1", name: "Bash", target: "bun test\nmore", note: "Run tests", start: 1_000 },
    ]);
    clock = 3_000;
    hook("post-tool-use", { tool_name: "Bash", tool_use_id: "t1", tool_input: {} });
    expect(activity().tools[0]?.end).toBe(3_000);
    expect(activity().toolCount).toBe(1);
    expect(activity().turnStart).toBe(1_000);
  });

  test("a failed tool keeps the first line of its error", () => {
    hook("pre-tool-use", {
      tool_name: "Read",
      tool_use_id: "t1",
      tool_input: { file_path: "/repo/a.ts" },
    });
    hook("post-tool-use-failure", {
      tool_name: "Read",
      tool_use_id: "t1",
      tool_input: { file_path: "/repo/a.ts" },
      error: "\nFile does not exist.\nmore",
    });
    const [tool] = activity().tools;
    expect(tool).toMatchObject({ target: "a.ts", failed: true, error: "File does not exist." });
    expect(activity().failedCount).toBe(1);
  });

  test("a new prompt counts again, and ends what the last turn left open", () => {
    hook("pre-tool-use", {
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: "sleep 9" },
    });
    hook("pre-tool-use", {
      tool_name: "Bash",
      tool_use_id: "t2",
      tool_input: { command: "server", run_in_background: true },
    });
    clock = 5_000;
    hook("user-prompt-submit", { prompt: "next" });
    const { tools, toolCount, turnStart } = activity();
    expect(tools[0]?.end).toBe(5_000);
    // A background command goes on.
    expect(tools[1]?.end).toBeUndefined();
    expect(tools[1]?.background).toBe(true);
    expect(toolCount).toBe(0);
    expect(turnStart).toBe(5_000);
  });

  test("keeps the latest tools only", () => {
    for (let i = 0; i < SESSION_TOOLS_KEPT + 5; i++) {
      hook("pre-tool-use", {
        tool_name: "Glob",
        tool_use_id: `t${i}`,
        tool_input: { pattern: "*" },
      });
    }
    const { tools, toolCount } = activity();
    expect(tools).toHaveLength(SESSION_TOOLS_KEPT);
    expect(tools[0]?.id).toBe("t5");
    expect(toolCount).toBe(SESSION_TOOLS_KEPT + 5);
  });

  test("the files written, relative to the session's directory", () => {
    for (const [id, name, input] of [
      ["t1", "Edit", { file_path: "/repo/src/a.ts" }],
      ["t2", "Write", { file_path: "/elsewhere/b.ts" }],
      ["t3", "Edit", { file_path: "/repo/src/a.ts" }],
      ["t4", "Read", { file_path: "/repo/c.ts" }],
      ["t5", "NotebookEdit", { notebook_path: "/repo/n.ipynb" }],
    ] as const) {
      hook("pre-tool-use", { tool_name: name, tool_use_id: id, tool_input: input });
      hook("post-tool-use", { tool_name: name, tool_use_id: id, tool_input: input });
    }
    hook("pre-tool-use", {
      tool_name: "Edit",
      tool_use_id: "t6",
      tool_input: { file_path: "/repo/x" },
    });
    hook("post-tool-use-failure", {
      tool_name: "Edit",
      tool_use_id: "t6",
      tool_input: { file_path: "/repo/x" },
    });
    expect(activity().files).toEqual(["src/a.ts", "/elsewhere/b.ts", "n.ipynb"]);
  });
});

describe("todos", () => {
  test("TodoWrite sets the list", () => {
    hook("pre-tool-use", {
      tool_name: "TodoWrite",
      tool_use_id: "t1",
      tool_input: {
        todos: [
          { content: "Read", activeForm: "Reading", status: "completed" },
          { content: "Write", activeForm: "Writing", status: "in_progress" },
          { content: "bad", status: "unknown" },
        ],
      },
    });
    expect(activity().todos).toEqual([
      { content: "Read", activeForm: "Reading", status: "completed" },
      { content: "Write", activeForm: "Writing", status: "in_progress" },
    ]);
  });

  test("a subagent's TodoWrite is its own", () => {
    hook("pre-tool-use", {
      tool_name: "TodoWrite",
      agent_id: "a1",
      tool_use_id: "t1",
      tool_input: { todos: [{ content: "x", status: "pending" }] },
    });
    expect(activity().todos).toEqual([]);
  });

  test("TaskCreate adds a task once created; TaskUpdate changes it", () => {
    const create = { subject: "Fix it", description: "d", activeForm: "Fixing it" };
    hook("pre-tool-use", { tool_name: "TaskCreate", tool_use_id: "t1", tool_input: create });
    hook("post-tool-use", {
      tool_name: "TaskCreate",
      tool_use_id: "t1",
      tool_input: create,
      tool_response: { task: { id: "1", subject: "Fix it" } },
    });
    expect(activity().todos).toEqual([
      { id: "1", content: "Fix it", activeForm: "Fixing it", status: "pending" },
    ]);
    hook("pre-tool-use", {
      tool_name: "TaskUpdate",
      agent_id: "a1",
      tool_use_id: "t2",
      tool_input: { taskId: "1", status: "in_progress" },
    });
    expect(activity().todos[0]?.status).toBe("in_progress");
    expect(activity().tools.map((tool) => tool.target)).toEqual(["Fix it"]);
    hook("pre-tool-use", {
      tool_name: "TaskUpdate",
      tool_use_id: "t3",
      tool_input: { taskId: "1", status: "deleted" },
    });
    expect(activity().todos).toEqual([]);
  });
});

describe("agents", () => {
  const explore = {
    subagent_type: "Explore",
    description: "Find hooks",
    prompt: "Find the hooks",
    model: "haiku",
  };

  test("a foreground agent is matched to its call and runs its own tools", () => {
    hook("pre-tool-use", { tool_name: "Agent", tool_use_id: "t1", tool_input: explore });
    clock = 2_000;
    hook("subagent-start", { agent_id: "a1", agent_type: "Explore" });
    hook("pre-tool-use", {
      agent_id: "a1",
      agent_type: "Explore",
      tool_name: "Grep",
      tool_use_id: "g1",
      tool_input: { pattern: "hook", path: "/repo/src" },
    });
    const [agent] = activity().agents;
    expect(agent).toMatchObject({
      id: "a1",
      kind: "subagent",
      type: "Explore",
      model: "haiku",
      description: "Find hooks",
      prompt: "Find the hooks",
      start: 2_000,
      state: "running",
      toolCount: 1,
    });
    expect(agent?.tools[0]?.target).toBe('"hook" · src');
    // The agent's tools are not the session's.
    expect(activity().tools.map((tool) => tool.id)).toEqual(["t1"]);

    clock = 9_000;
    hook("subagent-stop", {
      agent_id: "a1",
      agent_type: "Explore",
      last_assistant_message: "Found.",
    });
    expect(activity().agents[0]).toMatchObject({
      state: "completed",
      end: 9_000,
      answer: "Found.",
    });
    expect(activity().agents[0]?.tools[0]?.end).toBe(9_000);
    expect(changes.map((change) => change.state)).toEqual(["running", "completed"]);
  });

  test("a background agent is named by its tool's answer before it starts", () => {
    const first = { ...explore, description: "One", run_in_background: true };
    const second = { ...explore, description: "Two", run_in_background: true };
    hook("pre-tool-use", { tool_name: "Agent", tool_use_id: "t1", tool_input: first });
    hook("pre-tool-use", { tool_name: "Agent", tool_use_id: "t2", tool_input: second });
    hook("post-tool-use", {
      tool_name: "Agent",
      tool_use_id: "t2",
      tool_input: second,
      tool_response: { status: "async_launched", agentId: "a2", resolvedModel: "claude-haiku" },
    });
    hook("subagent-start", { agent_id: "a2", agent_type: "Explore" });
    hook("subagent-start", { agent_id: "a1", agent_type: "Explore" });
    const byId = new Map(activity().agents.map((agent) => [agent.id, agent]));
    expect(byId.get("a2")).toMatchObject({
      description: "Two",
      model: "claude-haiku",
      background: true,
    });
    expect(byId.get("a1")).toMatchObject({ description: "One", background: true });
  });

  test("an agent waits on its permission until it goes on", () => {
    hook("subagent-start", { agent_id: "a1", agent_type: "general-purpose" });
    const call = { tool_name: "Bash", tool_input: { command: "rm x" } };
    hook("permission-request", { agent_id: "a1", ...call });
    // Its PreToolUse runs async, and may come after.
    hook("pre-tool-use", { agent_id: "a1", tool_use_id: "b1", ...call });
    expect(activity().agents[0]?.state).toBe("permissionPending");
    hook("post-tool-use", { agent_id: "a1", tool_use_id: "b1", ...call });
    expect(activity().agents[0]?.state).toBe("running");

    hook("permission-request", { agent_id: "a1", ...call });
    hook("pre-tool-use", {
      agent_id: "a1",
      tool_use_id: "b2",
      tool_name: "Read",
      tool_input: { file_path: "/repo/a" },
    });
    expect(activity().agents[0]?.state).toBe("running");
    expect(changes.map((change) => change.state)).toEqual([
      "running",
      "permissionPending",
      "running",
      "permissionPending",
      "running",
    ]);
  });

  test("an agent told of first by its own hooks starts then", () => {
    hook("pre-tool-use", {
      agent_id: "a9",
      agent_type: "Plan",
      tool_name: "Read",
      tool_use_id: "r1",
      tool_input: { file_path: "/repo/a" },
    });
    expect(activity().agents[0]).toMatchObject({ id: "a9", type: "Plan", state: "running" });
  });

  test("a foreground agent left running by the last turn was stopped with it", () => {
    hook("pre-tool-use", { tool_name: "Agent", tool_use_id: "t1", tool_input: explore });
    hook("subagent-start", { agent_id: "a1", agent_type: "Explore" });
    hook("pre-tool-use", {
      tool_name: "Agent",
      tool_use_id: "t2",
      tool_input: { ...explore, run_in_background: true },
    });
    hook("subagent-start", { agent_id: "a2", agent_type: "Explore" });
    clock = 4_000;
    hook("user-prompt-submit", { prompt: "next" });
    const byId = new Map(activity().agents.map((agent) => [agent.id, agent]));
    expect(byId.get("a1")).toMatchObject({ state: "stopped", end: 4_000 });
    expect(byId.get("a2")?.state).toBe("running");
  });

  test("an Agent call that failed starts no agent", () => {
    hook("pre-tool-use", { tool_name: "Agent", tool_use_id: "t1", tool_input: explore });
    hook("post-tool-use-failure", { tool_name: "Agent", tool_use_id: "t1", tool_input: explore });
    hook("subagent-start", { agent_id: "a1", agent_type: "Explore" });
    expect(activity().agents[0]?.description).toBeUndefined();
  });

  test("lists running agents first, then the latest ended ones", () => {
    for (let i = 0; i < ENDED_AGENTS_KEPT + 3; i++) {
      clock = 1_000 + i;
      hook("subagent-start", { agent_id: `done${i}` });
      hook("subagent-stop", { agent_id: `done${i}` });
    }
    hook("subagent-start", { agent_id: "live" });
    const ids = activity().agents.map((agent) => agent.id);
    expect(ids).toHaveLength(ENDED_AGENTS_KEPT + 1);
    expect(ids[0]).toBe("live");
    expect(ids[1]).toBe(`done${ENDED_AGENTS_KEPT + 2}`);
  });
});

describe("sessions", () => {
  test("a new session starts a new record; compaction does not", () => {
    hook("pre-tool-use", { tool_name: "Glob", tool_use_id: "t1", tool_input: { pattern: "*" } });
    hook("session-start", { source: "compact" });
    expect(activity().tools).toHaveLength(1);
    hook("session-start", { source: "clear" });
    expect(activity().tools).toHaveLength(0);
  });

  test("the agents a session still ran stop with it", () => {
    hook("subagent-start", { agent_id: "a1" });
    hook("subagent-start", { agent_id: "a2" });
    hook("subagent-stop", { agent_id: "a2" });
    changes = [];
    clock = 7_000;
    hook("session-end");
    expect(changes.map((change) => [change.id, change.state, change.end])).toEqual([
      ["a1", "stopped", 7_000],
    ]);
  });

  test("an ended session is forgotten", () => {
    hook("user-prompt-submit", { prompt: "go" });
    hook("session-end");
    expect(log.get(WS, TAB)).toBeNull();
    hook("user-prompt-submit", { prompt: "go" });
    log.clear(WS, TAB);
    expect(log.get(WS, TAB)).toBeNull();
  });

  test("lists the sessions of the workspaces asked for", () => {
    log.noteHook("ws-1", "a", "user-prompt-submit", {});
    log.noteHook("ws-2", "b", "user-prompt-submit", {});
    log.noteHook("ws-3", "c", "user-prompt-submit", {});
    expect(log.list(["ws-1", "ws-3"]).map((a) => a.tabId)).toEqual(["a", "c"]);
    log.clearWorkspace("ws-1");
    expect(log.list(["ws-1", "ws-3"]).map((a) => a.tabId)).toEqual(["c"]);
  });

  test("a snapshot is a copy", () => {
    hook("pre-tool-use", { tool_name: "Glob", tool_use_id: "t1", tool_input: { pattern: "*" } });
    const before = activity();
    hook("post-tool-use", { tool_name: "Glob", tool_use_id: "t1", tool_input: {} });
    expect(before.tools[0]?.end).toBeUndefined();
  });
});

describe("describeTool", () => {
  test.each([
    ["Read", { file_path: "/repo/src/a.ts" }, { target: "src/a.ts" }],
    ["Grep", { pattern: "x" }, { target: '"x"' }],
    ["Glob", { pattern: "**/*.ts" }, { target: "**/*.ts" }],
    ["WebFetch", { url: "https://a.b" }, { target: "https://a.b" }],
    ["WebSearch", { query: "q" }, { target: "q" }],
    ["Agent", { description: "d", subagent_type: "Explore" }, { target: "d", note: "Explore" }],
    ["Skill", { skill: "review" }, { target: "review" }],
    ["TaskUpdate", { taskId: "3", status: "completed" }, { target: "#3 completed" }],
    ["TodoWrite", { todos: [] }, {}],
    ["mcp__x__y", { n: 1, query: "find" }, { target: "find" }],
  ] as const)("%s", (name, input, expected) => {
    expect(describeTool(name, input as Record<string, unknown>, CWD)).toEqual(expected);
  });

  test("a long target is cut", () => {
    const { target } = describeTool("Bash", { command: "x".repeat(3_000) }, CWD);
    expect(target?.length).toBe(2_001);
  });
});
