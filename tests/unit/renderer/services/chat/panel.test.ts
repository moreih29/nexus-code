import { describe, expect, test } from "bun:test";
import { resultFiles } from "../../../../../src/renderer/services/chat/links";
import {
  applyLines,
  type ChatLine,
  type ChatModel,
  emptyModel,
} from "../../../../../src/renderer/services/chat/model";
import {
  agentsOf,
  agentTranscript,
  answerExtras,
  changedFilesOf,
  contextOf,
  distinctResults,
  jobCommand,
  jobOutputFile,
  jobOutputFiles,
  jobsOf,
  outsideLinksOf,
  resultsOf,
  sentFilesOf,
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

  test("a job runs its Bash call's command, and writes where the call's result or its end says", () => {
    const model = turn();
    const job = model.tasks.b1;
    expect(jobCommand(job, model.tools)).toBe("sleep 25; echo done");
    // A result that does not say where tells no file.
    expect(jobOutputFile(job, model.tools)).toBeUndefined();
    expect(jobOutputFiles(model, model.tools)).toEqual([]);

    const path = "/private/tmp/claude-501/-p/s1/tasks/b1.output";
    const said = applyLines(model, [
      result(
        "bash1",
        `Command running in background with ID: b1. Output is being written to: ${path}. You will be notified when it completes.`,
        { backgroundTaskId: "b1" },
      ),
    ]);
    expect(jobOutputFile(said.tasks.b1, said.tools)).toBe(path);
    expect(jobOutputFiles(said, said.tools)).toEqual([path]);

    const ended = applyLines(model, [
      out({
        type: "system",
        subtype: "task_notification",
        task_id: "b1",
        tool_use_id: "bash1",
        status: "completed",
        summary: 'Background command "Sleep 25 seconds" completed (exit code 0)',
        output_file: path,
      }),
    ]);
    expect(jobOutputFile(ended.tasks.b1, ended.tools)).toBe(path);
    // An agent's task is no job, and its output is not read.
    expect(jobOutputFiles(ended, ended.tools)).toEqual([path]);
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

  test("changed files add up their patches, and keep what each was before", () => {
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
        { type: "tool_use", id: "e2", name: "Edit", input: { file_path: "/p/old.ts" } },
        { type: "tool_use", id: "n", name: "NotebookEdit", input: { notebook_path: "/p/n.ipynb" } },
      ]),
      result("w", "ok", { type: "create", filePath: "/p/new.txt", originalFile: null }),
      result("e", "ok", {
        originalFile: "keep\nold\n",
        structuredPatch: [{ oldStart: 1, lines: [" keep", "-old", "+new", "+more"] }],
      }),
      result("e2", "ok", {
        originalFile: "keep\nnew\nmore\n",
        structuredPatch: [{ oldStart: 3, lines: ["-more"] }],
      }),
      result("n", "ok", { new_source: "x" }),
    ]);
    expect(changedFilesOf(model.tools)).toEqual([
      { path: "/p/new.txt", added: 2, removed: 0, created: true, before: null, toolUseIds: ["w"] },
      {
        path: "/p/old.ts",
        added: 2,
        removed: 2,
        created: false,
        before: "keep\nold\n",
        toolUseIds: ["e", "e2"],
      },
      { path: "/p/n.ipynb", added: 0, removed: 0, created: false, toolUseIds: ["n"] },
    ]);
  });

  test("a Windows file is one changed file, and its links are results", () => {
    seq = 0;
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        { type: "tool_use", id: "e", name: "Edit", input: { file_path: "C:\\p\\a.ts" } },
        { type: "tool_use", id: "e2", name: "Edit", input: { file_path: "C:/p/a.ts" } },
      ]),
      result("e", "ok", { structuredPatch: [{ oldStart: 1, lines: ["-a", "+b"] }] }),
      result("e2", "ok", { structuredPatch: [{ oldStart: 1, lines: ["-b", "+c"] }] }),
      assistant("m2", [
        { type: "tool_use", id: "r", name: "Read", input: { file_path: "C:\\P\\SRC\\B.ts" } },
        {
          type: "text",
          text: "See [a.ts](C:\\p\\a.ts), `src\\b.ts` and `D:\\out\\log.txt`.",
        },
      ]),
    ]);
    expect(changedFilesOf(model.tools)).toEqual([
      { path: "C:/p/a.ts", added: 2, removed: 2, created: false, toolUseIds: ["e", "e2"] },
    ]);
    // A Windows path is the file the tools took whatever its case.
    expect(resultsOf(model.items, model.tools, "C:\\p")).toEqual([
      { kind: "file", target: "C:\\p\\a.ts", created: false },
      { kind: "file", target: "src\\b.ts", created: false },
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
        { type: "tool_use", id: "r", name: "Read", input: { file_path: "/p/src/app.ts" } },
        {
          type: "text",
          text: "See [the report](/p/report.md), `src/app.ts`, `npm run build`, and https://example.com/docs. Also [site](http://localhost:3000).",
        },
      ]),
    ]);
    expect(resultsOf(model.items, model.tools, "/p")).toEqual([
      { kind: "file", target: "/p/report.md", created: true },
      { kind: "url", target: "http://localhost:3000", created: false },
      { kind: "url", target: "https://example.com/docs", created: false },
      { kind: "file", target: "src/app.ts", created: false },
    ]);
  });

  test("a path only backticks name is a file the session's tools took; a lone /word is a command", () => {
    seq = 0;
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        {
          type: "tool_use",
          id: "e",
          name: "Edit",
          input: { file_path: "/p/build/notes.json" },
        },
        {
          type: "text",
          text: "Bumped `package.json` and `build/notes.json` for `v0.17.0`; `system.stats` is new, see `/config` and `/etc/hosts`.",
        },
      ]),
      assistant("m2", [{ type: "text", text: "Also [the manifest](package.json)." }]),
    ]);
    expect(resultsOf(model.items, model.tools, "/p")).toEqual([
      { kind: "file", target: "build/notes.json", created: false },
      // Linked in a later reply.
      { kind: "file", target: "package.json", created: false },
    ]);
  });

  test("a path a reply only mentions, of a server or a run, is no result", () => {
    seq = 0;
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        { type: "tool_use", id: "r", name: "Read", input: { file_path: "/p/notes.md" } },
        { type: "tool_use", id: "b", name: "Bash", input: { command: "ssh server2 ls" } },
        {
          type: "text",
          text: "The `/dev/shm` cache is gone. The code is on server2 in `experiments/e306/` (`p1_cap2000.py`, `README.md`); see `notes.md`.",
        },
      ]),
    ]);
    expect(resultsOf(model.items, model.tools, "/p")).toEqual([
      { kind: "file", target: "notes.md", created: false },
    ]);
  });

  test("a relative path parted by backslashes is a Windows path once resolved", () => {
    seq = 0;
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        { type: "tool_use", id: "r1", name: "Read", input: { file_path: "C:\\w\\src\\greet.ts" } },
        { type: "tool_use", id: "r2", name: "Read", input: { file_path: "C:\\w\\lib\\util.ts" } },
        { type: "text", text: "See `src\\greet.ts`, `.\\lib\\util.ts` and `nope\\`." },
      ]),
    ]);
    const results = resultsOf(model.items, model.tools, "C:\\w");
    expect(results).toEqual([
      { kind: "file", target: "src\\greet.ts", created: false },
      { kind: "file", target: ".\\lib\\util.ts", created: false },
    ]);
    expect(resultFiles(results, "C:\\w")).toEqual(["C:/w/src/greet.ts", "C:/w/lib/util.ts"]);
  });

  test("a finished turn's answer ends with its files and its tools' images", () => {
    seq = 0;
    const ask = (text: string): ChatLine => ({
      seq: ++seq,
      dir: "in",
      message: { type: "user", message: { role: "user", content: text } },
    });
    const model = applyLines(emptyModel(), [
      ask("make a chart"),
      assistant("m1", [
        { type: "tool_use", id: "w", name: "Write", input: { file_path: "/p/out/chart.md" } },
      ]),
      result("w", "ok", { type: "create", filePath: "/p/out/chart.md" }),
      assistant("m2", [
        { type: "tool_use", id: "r", name: "Read", input: { file_path: "/p/shot.png" } },
      ]),
      out({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "r",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "AAAA" },
                },
              ],
            },
          ],
        },
      }),
      assistant("m3", [{ type: "text", text: "Done: [chart](out/chart.md) and `docs/a.pdf`." }]),
      ask("again"),
      assistant("m4", [{ type: "text", text: "See [b](b.md)." }]),
    ]);
    const answers = (done: boolean) =>
      [...answerExtras(model.items, model.tools, "/p", "/p", done)].map(([item, extras]) => [
        item.kind === "assistant" ? item.messageId : item.kind,
        extras.files,
        extras.images.length,
      ]);
    // `docs/a.pdf` only mentioned is no card.
    expect(answers(true)).toEqual([
      ["m3", ["/p/out/chart.md"], 1],
      ["m4", ["/p/b.md"], 0],
    ]);
    // The running turn's answer is not the last yet.
    expect(answers(false)).toEqual([["m3", ["/p/out/chart.md"], 1]]);
    // The image a Read gave opens as the file it read.
    const [first] = answerExtras(model.items, model.tools, "/p", "/p", true).values();
    expect(first.images).toEqual([
      { image: { mediaType: "image/png", data: "AAAA" }, file: "/p/shot.png" },
    ]);
  });

  test("files sent the user, and images a reply shows, are results with no card of their own", () => {
    seq = 0;
    const ask: ChatLine = {
      seq: ++seq,
      dir: "in",
      message: { type: "user", message: { role: "user", content: "send me the chart" } },
    };
    // As claude 2.1.319 sends them with Remote Control on.
    const send = {
      files: ["out/chart.png", "/tmp/report.pdf"],
      caption: "The chart",
      status: "normal",
      display: "render",
    };
    const model = applyLines(emptyModel(), [
      ask,
      assistant("m1", [{ type: "tool_use", id: "s", name: "SendUserFile", input: send }]),
      result("s", "2 files delivered to user.", undefined),
      assistant("m2", [
        { type: "tool_use", id: "f", name: "SendUserFile", input: { files: ["/p/lost.png"] } },
      ]),
      out({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "f", content: "failed", is_error: true }],
        },
      }),
      assistant("m3", [
        { type: "text", text: "Sent. ![plot](out/plot.png) is the other; see [notes](notes.md)." },
      ]),
    ]);
    expect(sentFilesOf(model.tools.s)).toEqual(["out/chart.png", "/tmp/report.pdf"]);
    expect(sentFilesOf(model.tools.f)).toEqual(["/p/lost.png"]);
    expect(sentFilesOf({ ...model.tools.s, input: { files: ["a.png", 3, "", null] } })).toEqual([
      "a.png",
    ]);
    expect(sentFilesOf({ ...model.tools.s, name: "Read" })).toEqual([]);
    // A send that failed put nothing in front of the user.
    expect(resultsOf(model.items, model.tools, "/p")).toEqual([
      { kind: "file", target: "out/chart.png", created: false },
      { kind: "file", target: "/tmp/report.pdf", created: false },
      { kind: "file", target: "out/plot.png", created: false },
      { kind: "file", target: "notes.md", created: false },
    ]);
    // What shows where the turn put it gets no card at its end.
    const [extras] = answerExtras(model.items, model.tools, "/p", "/p", true).values();
    expect(extras.files).toEqual(["/p/notes.md"]);
    // A file sent from outside the workspace is one its previews read.
    expect(outsideLinksOf(model.items, model.tools, "/p", "/p").files).toEqual(["/tmp/report.pdf"]);
  });

  test("what a session links outside the workspace, with its HTML files' folders", () => {
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/tmp/shot.png" } },
        { type: "tool_use", id: "r2", name: "Read", input: { file_path: "/p/src/a.ts" } },
        { type: "tool_use", id: "w", name: "Write", input: { file_path: "/tmp/site/index.html" } },
        { type: "tool_use", id: "n", name: "NotebookEdit", input: { notebook_path: "../n.ipynb" } },
      ]),
      assistant("m2", [
        {
          type: "text",
          text: "See [report](/var/out/report.htm), `docs/b.md` and [home](/home/u/index.html).",
        },
      ]),
    ]);
    const links = outsideLinksOf(model.items, model.tools, "/home/u/p", "/home/u/p", ["/x/y.pdf"]);
    expect(links.files).toEqual([
      "/x/y.pdf",
      "/tmp/shot.png",
      "/p/src/a.ts",
      "/tmp/site/index.html",
      "/home/u/n.ipynb",
      "/var/out/report.htm",
      "/home/u/index.html",
    ]);
    // The home folder holds the workspace, so it is not granted whole.
    expect(links.dirs).toEqual(["/tmp/site", "/var/out"]);
    expect(outsideLinksOf(model.items, model.tools, "/home/u/p", "")).toEqual({
      files: [],
      dirs: [],
    });
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

describe("distinctResults", () => {
  test("lists a file once however its path was written, made new if it ever was", () => {
    const results = distinctResults(
      [
        { kind: "file", target: "long.txt", created: false, guessed: true },
        { kind: "url", target: "https://example.com", created: false, guessed: false },
        { kind: "file", target: "/p/long.txt", created: false, guessed: false },
        { kind: "file", target: "./src/a.ts", created: false, guessed: false },
        { kind: "file", target: "/p/src/a.ts", created: true, guessed: false },
        { kind: "url", target: "https://example.com/x", created: false, guessed: false },
      ],
      "/p",
    );
    expect(results).toEqual([
      { kind: "file", target: "long.txt", created: false, guessed: true },
      { kind: "url", target: "https://example.com", created: false, guessed: false },
      { kind: "file", target: "./src/a.ts", created: true, guessed: false },
      { kind: "url", target: "https://example.com/x", created: false, guessed: false },
    ]);
  });
});
