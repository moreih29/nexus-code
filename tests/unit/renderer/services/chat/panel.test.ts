import { describe, expect, test } from "bun:test";
import {
  applyLines,
  type ChatLine,
  type ChatModel,
  emptyModel,
} from "../../../../../src/renderer/services/chat/model";
import {
  agentsOf,
  agentTranscript,
  changedFilesOf,
  contextOf,
  jobsOf,
  resultsOf,
  todosOf,
  usageLimitsOf,
} from "../../../../../src/renderer/services/chat/panel";

// Lines shaped as Claude Code 2.1.318 sent them for a turn that made two
// to-dos, ran `sleep` in the background and an async general-purpose agent.

let seq = 0;
function out(message: Record<string, unknown>): ChatLine {
  seq += 1;
  return { seq, dir: "out", at: 1000 + seq, message };
}

function assistant(id: string, content: unknown[], parent: string | null = null): ChatLine {
  return out({
    type: "assistant",
    uuid: `u-${id}-${seq}`,
    parent_tool_use_id: parent,
    message: { id, role: "assistant", content },
  });
}

function result(
  toolUseId: string,
  text: string,
  structured: unknown,
  parent: string | null = null,
) {
  return out({
    type: "user",
    parent_tool_use_id: parent,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }],
    },
    tool_use_result: structured,
  });
}

function turn(): ChatModel {
  seq = 0;
  const lines: ChatLine[] = [
    { seq: ++seq, dir: "sys", message: { event: "start", pid: 1 } },
    assistant("m1", [
      { type: "tool_use", id: "t1", name: "TaskCreate", input: { subject: "plan" } },
    ]),
    result("t1", "Task #1 created successfully: plan", { task: { id: "1", subject: "plan" } }),
    assistant("m2", [
      { type: "tool_use", id: "t2", name: "TaskCreate", input: { subject: "finish" } },
    ]),
    result("t2", "Task #2 created successfully: finish", { task: { id: "2", subject: "finish" } }),
    assistant("m3", [
      {
        type: "tool_use",
        id: "bash1",
        name: "Bash",
        input: { command: "sleep 25; echo done", run_in_background: true },
      },
    ]),
    out({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "b1", task_type: "local_bash", description: "Sleep 25 seconds" }],
    }),
    out({
      type: "system",
      subtype: "task_started",
      task_id: "b1",
      tool_use_id: "bash1",
      description: "Sleep 25 seconds",
      is_backgrounded: true,
      task_type: "local_bash",
    }),
    result("bash1", "Command running in background with ID: b1.", { backgroundTaskId: "b1" }),
    assistant("m4", [
      {
        type: "tool_use",
        id: "agent1",
        name: "Agent",
        input: {
          description: "Reply with number 4",
          prompt: "Reply with the number 4.",
          subagent_type: "general-purpose",
        },
      },
    ]),
    out({
      type: "system",
      subtype: "task_started",
      task_id: "a1",
      tool_use_id: "agent1",
      description: "Reply with number 4",
      subagent_type: "general-purpose",
      is_backgrounded: true,
      task_type: "local_agent",
      prompt: "Reply with the number 4.",
    }),
    result("agent1", "Async agent launched successfully", {
      isAsync: true,
      status: "async_launched",
      agentId: "a1",
      resolvedModel: "claude-haiku-5-5",
    }),
    assistant(
      "s1",
      [{ type: "tool_use", id: "sub1", name: "Read", input: { file_path: "/p/a" } }],
      "agent1",
    ),
    out({
      type: "system",
      subtype: "task_progress",
      task_id: "a1",
      tool_use_id: "agent1",
      description: "Reading /p/a",
      last_tool_name: "Read",
    }),
    assistant("s2", [{ type: "text", text: "4" }], "agent1"),
    out({
      type: "system",
      subtype: "task_updated",
      task_id: "a1",
      patch: { status: "completed", end_time: 5000 },
    }),
    out({
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      tool_use_id: "agent1",
      status: "completed",
      summary: "4",
      usage: { total_tokens: 11978, tool_uses: 0, duration_ms: 938 },
    }),
    assistant("m5", [
      {
        type: "tool_use",
        id: "t3",
        name: "TaskUpdate",
        input: { taskId: "1", status: "completed" },
      },
    ]),
    result("t3", "Updated task #1 status", { success: true, taskId: "1" }),
  ];
  return applyLines(emptyModel(), lines);
}

describe("chat panel", () => {
  test("tasks follow the CLI's task events", () => {
    const model = turn();
    expect(model.tasks.b1).toMatchObject({
      type: "local_bash",
      status: "running",
      toolUseId: "bash1",
      backgrounded: true,
    });
    expect(model.tasks.a1).toMatchObject({
      type: "local_agent",
      description: "Reply with number 4",
      activity: "Reading /p/a",
      status: "completed",
      endedAt: 5000,
      summary: "4",
      totalTokens: 11978,
    });
    expect(jobsOf(model).map((t) => t.taskId)).toEqual(["b1"]);

    // The program's end ends what it ran.
    const exited = applyLines(model, [
      { seq: 100, dir: "sys", at: 9000, message: { event: "exit", code: 0 } },
    ]);
    expect(exited.tasks.b1).toMatchObject({ status: "stopped", endedAt: 9000 });
    expect(exited.tasks.a1.status).toBe("completed");
  });

  test("an agent row joins its Agent call, its task and its own messages", () => {
    const model = turn();
    const [agent] = agentsOf(model);
    expect(agent).toMatchObject({
      toolUseId: "agent1",
      taskId: "a1",
      description: "Reply with number 4",
      subagentType: "general-purpose",
      model: "claude-haiku-5-5",
      status: "completed",
      toolCount: 1,
      lastText: "4",
      teammate: false,
    });
    // Its messages stay out of the main thread, and make its pane.
    expect(model.items.some((item) => item.kind === "assistant" && item.messageId === "s2")).toBe(
      false,
    );
    const pane = agentTranscript(model, agent);
    expect(pane.map((item) => item.kind)).toEqual(["user", "assistant", "assistant"]);
    expect(pane[0]).toMatchObject({ kind: "user", text: "Reply with the number 4." });
  });

  test("the to-do list follows TaskCreate and TaskUpdate", () => {
    expect(todosOf(turn().tools)).toEqual([
      { id: "1", content: "plan", status: "completed" },
      { id: "2", content: "finish", status: "pending" },
    ]);
  });

  test("the to-do list takes TodoWrite's latest list", () => {
    seq = 0;
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        {
          type: "tool_use",
          id: "w1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "a", status: "in_progress", activeForm: "A" },
              { content: "b", status: "pending", activeForm: "B" },
            ],
          },
        },
      ]),
    ]);
    expect(todosOf(model.tools)).toEqual([
      { id: "1", content: "a", status: "in_progress" },
      { id: "2", content: "b", status: "pending" },
    ]);
  });

  test("changed files add up their patches", () => {
    seq = 0;
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        {
          type: "tool_use",
          id: "w",
          name: "Write",
          input: { file_path: "/p/new.txt", content: "a\nb\n" },
        },
        { type: "tool_use", id: "e", name: "Edit", input: { file_path: "/p/old.ts" } },
        { type: "tool_use", id: "x", name: "Edit", input: { file_path: "/p/denied.ts" } },
      ]),
      result("w", "ok", { type: "create", filePath: "/p/new.txt" }),
      result("e", "ok", {
        structuredPatch: [{ oldStart: 1, lines: [" keep", "-old", "+new", "+more"] }],
      }),
    ]);
    expect(changedFilesOf(model.tools)).toEqual([
      { path: "/p/new.txt", added: 2, removed: 0, created: true, toolUseIds: ["w"] },
      { path: "/p/old.ts", added: 2, removed: 1, created: false, toolUseIds: ["e"] },
    ]);
  });

  test("results are the files written new, then what the replies point at", () => {
    seq = 0;
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        {
          type: "tool_use",
          id: "w",
          name: "Write",
          input: { file_path: "/p/report.md", content: "x" },
        },
      ]),
      result("w", "ok", { type: "create", filePath: "/p/report.md" }),
      assistant("m2", [
        {
          type: "text",
          text: "See [the report](/p/report.md), `src/app.ts`, `npm run build`, and https://example.com/docs. Also [site](http://localhost:3000).",
        },
      ]),
    ]);
    expect(resultsOf(model.items, model.tools)).toEqual([
      { kind: "file", target: "/p/report.md", created: true },
      { kind: "url", target: "http://localhost:3000", created: false },
      { kind: "url", target: "https://example.com/docs", created: false },
      { kind: "file", target: "src/app.ts", created: false },
    ]);
  });

  test("context and usage read their answers", () => {
    expect(
      contextOf({
        categories: [
          { name: "System prompt", tokens: 3055, kind: "used" },
          { name: "System tools (deferred)", tokens: 17932, kind: "deferred" },
          { name: "Messages", tokens: 9477, kind: "used" },
          { name: "Autocompact buffer", tokens: 33000, kind: "buffer" },
          { name: "Free space", tokens: 942461, kind: "free" },
        ],
        totalTokens: 24539,
        maxTokens: 1000000,
        percentage: 2,
      }),
    ).toEqual({
      used: [
        { name: "System prompt", tokens: 3055 },
        { name: "Messages", tokens: 9477 },
      ],
      totalTokens: 24539,
      maxTokens: 1000000,
      free: 942461,
      percentage: 2,
    });
    expect(contextOf(undefined)).toBeNull();
    expect(
      usageLimitsOf({
        rate_limits: {
          limits: [
            { kind: "session", percent: 15, resets_at: "2026-11-05T19:20:00Z", is_active: false },
            {
              kind: "weekly_scoped",
              percent: 0,
              scope: { model: { display_name: "Fable" } },
              is_active: false,
            },
          ],
        },
      }),
    ).toEqual([
      { kind: "session", percent: 15, resetsAt: "2026-11-05T19:20:00Z", active: false },
      { kind: "weekly_scoped", scope: "Fable", percent: 0, active: false },
    ]);
  });
});
