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

describe("session", () => {
  test("the session id its hooks give, kept until the session ends", () => {
    hook("session-start", { session_id: "s-1", source: "resume" });
    expect(activity().sessionId).toBe("s-1");
    hook("user-prompt-submit", { prompt: "go" });
    expect(activity().sessionId).toBe("s-1");
    hook("session-end", { session_id: "s-1" });
    expect(log.get(WS, TAB)).toBeNull();
  });
});

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

describe("answers from the app", () => {
  const bash = { tool_name: "Bash", tool_input: { command: "rm -rf build" } };

  test("a call denied from the app ends unrun, and its agent goes on", () => {
    hook("user-prompt-submit", { prompt: "go" });
    hook("subagent-start", { agent_id: "a1", agent_type: "Explore" });
    hook("pre-tool-use", { ...bash, tool_use_id: "t1", agent_id: "a1" });
    hook("permission-request", { ...bash, agent_id: "a1" });
    expect(activity().agents[0]?.state).toBe("permissionPending");
    clock = 2_000;
    log.noteAnswered(WS, TAB, "a1", "Bash", "rm -rf build", true);
    const agent = activity().agents[0];
    expect(agent?.state).toBe("running");
    expect(agent?.tools[0]).toMatchObject({ id: "t1", end: 2_000, denied: true });
    expect(agent?.failedCount).toBe(0);
  });

  test("a call allowed from the app runs on", () => {
    hook("pre-tool-use", { ...bash, tool_use_id: "t1" });
    log.noteAnswered(WS, TAB, undefined, "Bash", "rm -rf build", false);
    expect(activity().tools[0]?.end).toBeUndefined();
  });

  test("a turn over with no hook stops the tools it left running", () => {
    hook("pre-tool-use", { ...bash, tool_use_id: "t1" });
    hook("pre-tool-use", {
      tool_name: "Bash",
      tool_use_id: "t2",
      tool_input: { command: "bun dev", run_in_background: true },
    });
    clock = 5_000;
    log.noteTurnOver(WS, TAB);
    expect(activity().tools.map((tool) => tool.end)).toEqual([5_000, undefined]);
  });
});

describe("`claude -p` runs", () => {
  function print(frame: string, payload: Record<string, unknown> = {}): void {
    log.notePrint(WS, TAB, frame, { run_id: "p1", ...payload });
  }

  test("a run is one of the session's agents, told by the command that started it", () => {
    hook("user-prompt-submit", { prompt: "go" });
    hook("pre-tool-use", {
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: "offload -e claude review", description: "Offload the review" },
    });
    clock = 1_500;
    print("print-start", { prompt: "review it", model: "glm", cwd: "/repo", tools_told: true });
    print("print-init", { model: "glm-4.6", cwd: "/repo/sub" });
    clock = 2_000;
    print("print-tool-use", {
      tool_use_id: "u1",
      tool_name: "Read",
      tool_input: { file_path: "/repo/sub/a.ts" },
    });
    print("print-tool-use", { tool_use_id: "u2", tool_name: "Bash", tool_input: { command: "x" } });
    clock = 3_000;
    print("print-tool-result", { tool_use_id: "u1", is_error: false });
    print("print-tool-result", { tool_use_id: "u2", is_error: true, error: "not found\nmore" });
    expect(activity().agents).toEqual([
      {
        id: "p1",
        kind: "print",
        model: "glm-4.6",
        description: "Offload the review",
        prompt: "review it",
        start: 1_500,
        state: "running",
        tools: [
          { id: "u1", name: "Read", target: "a.ts", start: 2_000, end: 3_000 },
          {
            id: "u2",
            name: "Bash",
            target: "x",
            start: 2_000,
            end: 3_000,
            failed: true,
            error: "not found",
          },
        ],
        toolCount: 2,
        failedCount: 1,
        toolsTold: true,
      },
    ]);
    // The run's tools are its own, not the session's.
    expect(activity().tools.map((tool) => tool.id)).toEqual(["t1"]);
  });

  test("a run ends as claude exited, with its answer", () => {
    print("print-start", { tools_told: true });
    print("print-tool-use", { tool_use_id: "u1", tool_name: "Read", tool_input: {} });
    clock = 4_000;
    print("print-end", { exit_code: 0, answer: "Done." });
    expect(activity().agents[0]).toMatchObject({
      state: "completed",
      end: 4_000,
      exitCode: 0,
      answer: "Done.",
    });
    expect(activity().agents[0]?.tools[0]?.end).toBe(4_000);
    // Told once: a late frame changes nothing.
    print("print-tool-use", { tool_use_id: "u2", tool_name: "Read", tool_input: {} });
    expect(activity().agents[0]?.toolCount).toBe(1);
    expect(changes.map((change) => change.state)).toEqual(["running", "completed"]);
  });

  test.each([
    [{ exit_code: 1 }, "failed"],
    [{ signal: "interrupt" }, "stopped"],
    [{ exit_code: 143, signal: "terminated" }, "stopped"],
  ])("a run that ended with %o is %s", (end, state) => {
    print("print-start");
    print("print-end", end);
    expect(activity().agents[0]?.state).toBe(state);
  });

  test("a run whose output tells nothing has no tools, and no description without a command", () => {
    print("print-start", { tools_told: false });
    expect(activity().agents[0]).toMatchObject({ kind: "print", toolsTold: false });
    expect(activity().agents[0]?.description).toBeUndefined();
  });

  test("a run whose transcript is found tells its tools from then", () => {
    print("print-start", { tools_told: false });
    print("print-init", { tools_told: true });
    print("print-init", { model: "glm-4.6" });
    expect(activity().agents[0]).toMatchObject({ toolsTold: true, model: "glm-4.6" });
  });

  test("a command left in the background tells the run it started", () => {
    hook("pre-tool-use", {
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: "offload &", description: "Offload", run_in_background: true },
    });
    hook("post-tool-use", { tool_name: "Bash", tool_use_id: "t1", tool_input: {} });
    hook("pre-tool-use", { tool_name: "Read", tool_use_id: "t2", tool_input: {} });
    print("print-start");
    expect(activity().agents[0]?.description).toBe("Offload");
  });

  test("a run outlives the turn that started it, not its session", () => {
    hook("user-prompt-submit", { prompt: "go" });
    print("print-start");
    hook("user-prompt-submit", { prompt: "next" });
    expect(activity().agents[0]?.state).toBe("running");
    hook("session-end");
    expect(changes.at(-1)).toMatchObject({ id: "p1", state: "stopped" });
  });

  test("a run gone before it told its end stops; one that told it stays as it ended", () => {
    print("print-start", { tools_told: true });
    print("print-tool-use", { tool_use_id: "u1", tool_name: "Read", tool_input: {} });
    clock = 5_000;
    print("print-gone");
    expect(activity().agents[0]).toMatchObject({ state: "stopped", end: 5_000 });
    expect(activity().agents[0]?.tools[0]?.end).toBe(5_000);
    log.notePrint(WS, TAB, "print-start", { run_id: "p2" });
    log.notePrint(WS, TAB, "print-end", { run_id: "p2", exit_code: 0 });
    log.notePrint(WS, TAB, "print-gone", { run_id: "p2" });
    expect(activity().agents.find((agent) => agent.id === "p2")?.state).toBe("completed");
  });

  test("frames of a run that never told its start change nothing", () => {
    hook("user-prompt-submit", { prompt: "go" });
    print("print-tool-use", { tool_use_id: "u1", tool_name: "Read", tool_input: {} });
    print("print-end", { exit_code: 0 });
    log.notePrint(WS, TAB, "print-start", {});
    expect(activity().agents).toEqual([]);
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
