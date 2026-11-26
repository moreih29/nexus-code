import { describe, expect, test } from "bun:test";
import { applyLines } from "../../../../../src/renderer/services/chat/claude/stream-model";
import { lookAtImage } from "../../../../../src/renderer/services/chat/image-look";
import { resultFiles } from "../../../../../src/renderer/services/chat/links";
import {
  type ChatItem,
  type ChatLine,
  type ChatModel,
  emptyModel,
  type ImageBlock,
  type ToolCall,
} from "../../../../../src/renderer/services/chat/model";
import {
  agentsOf,
  agentTranscript,
  answerExtras,
  answerLinks,
  attachedFilesIn,
  attachedImagesOf,
  changedFilesOf,
  changedShareFiles,
  contextOf,
  distinctResults,
  hostedOutsideFiles,
  imagesOf,
  jobCommand,
  jobOutputFile,
  jobOutputFiles,
  jobsOf,
  joinAgents,
  outsideLinkedFiles,
  outsideLinksOf,
  pastAgentsOf,
  resultSource,
  resultsOf,
  sentFilesOf,
  todosOf,
  usageLimitsOf,
} from "../../../../../src/renderer/services/chat/panel";
import { type RelaySender, relayedText } from "../../../../../src/shared/chat/relay";
import { shownPath } from "../../../../../src/shared/fs/relative-path";

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
        { type: "tool_use", id: "e3", name: "Edit", input: { file_path: "c:\\p\\a.ts" } },
      ]),
      result("e", "ok", { structuredPatch: [{ oldStart: 1, lines: ["-a", "+b"] }] }),
      result("e2", "ok", { structuredPatch: [{ oldStart: 1, lines: ["-b", "+c"] }] }),
      result("e3", "ok", { structuredPatch: [{ oldStart: 1, lines: ["-c", "+d"] }] }),
      assistant("m2", [
        { type: "tool_use", id: "r", name: "Read", input: { file_path: "C:\\P\\SRC\\B.ts" } },
        {
          type: "text",
          text: "See [a.ts](C:\\p\\a.ts), `src\\b.ts` and `D:\\out\\log.txt`.",
        },
      ]),
    ]);
    expect(changedFilesOf(model.tools)).toEqual([
      {
        path: "C:/p/a.ts",
        rawPath: "C:\\p\\a.ts",
        added: 3,
        removed: 3,
        created: false,
        toolUseIds: ["e", "e2", "e3"],
      },
    ]);
    expect(resultsOf(model.items, model.tools, "C:\\p")).toEqual([
      { kind: "file", target: "C:\\p\\a.ts", created: false },
      { kind: "file", target: "src\\b.ts", created: false },
    ]);
  });

  test.each([
    [
      "\\\\wsl.localhost\\Ubuntu\\tmp\\x.ts",
      "C:\\p",
      "//wsl.localhost/Ubuntu/tmp/x.ts",
      "\\\\wsl.localhost\\Ubuntu\\tmp\\x.ts",
    ],
    ["d:\\work\\y.ts", "C:\\p", "D:/work/y.ts", "d:\\work\\y.ts"],
    ["c:\\p\\src\\a.ts", "C:\\p", "C:/p/src/a.ts", "src/a.ts"],
    ["/home/me/p/src/a.ts", "/home/me/p", "/home/me/p/src/a.ts", "src/a.ts"],
    ["/Users/me/tmp/x.ts", "/Users/me/p", "/Users/me/tmp/x.ts", "/Users/me/tmp/x.ts"],
  ])("shows %s from %s using the tool path", (named, cwd, path, label) => {
    const model = applyLines(emptyModel(), [
      assistant("m1", [{ type: "tool_use", id: "e", name: "Edit", input: { file_path: named } }]),
      result("e", "ok", {}),
    ]);
    const [file] = changedFilesOf(model.tools);
    expect(file?.path).toBe(path);
    expect(shownPath(file?.rawPath ?? file?.path ?? "", cwd)).toBe(label);
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

  test("each result and answer card keeps the link as written and where it came from", () => {
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
        { type: "text", text: "See [notes](../qa/notes.md) and `src/app.ts`." },
      ]),
    ]);
    const answerKey = model.items.find(
      (item) => item.kind === "assistant" && item.messageId === "m2",
    )?.key;
    const results = resultsOf(model.items, model.tools, "/p");
    expect(results.map((result) => [result.target, resultSource(result)])).toEqual([
      ["/p/report.md", { kind: "tool", toolUseId: "w" }],
      ["../qa/notes.md", { kind: "answer", itemKey: answerKey }],
      ["src/app.ts", { kind: "answer", itemKey: answerKey }],
    ]);
    const [extras] = answerExtras(model.items, model.tools, "/p", "/p", true).values();
    expect(answerLinks(extras!)).toEqual({
      "/p/report.md": { href: "/p/report.md", source: { kind: "tool", toolUseId: "w" } },
      "/qa/notes.md": { href: "../qa/notes.md", source: { kind: "answer", itemKey: answerKey } },
      "/p/src/app.ts": { href: "src/app.ts", source: { kind: "answer", itemKey: answerKey } },
    });
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
    expect(answers(true)).toEqual([
      ["m3", ["/p/out/chart.md"], 1],
      ["m4", ["/p/b.md"], 0],
    ]);
    expect(answers(false)).toEqual([["m3", ["/p/out/chart.md"], 1]]);
    const [first] = answerExtras(model.items, model.tools, "/p", "/p", true).values();
    expect(first.images).toEqual([
      { image: { mediaType: "image/png", data: "AAAA" }, file: "/p/shot.png" },
    ]);
  });

  test("keeps files beyond the former candidate limit for quick look", () => {
    seq = 0;
    const files = Array.from({ length: 19 }, (_, i) => `qa-${i + 1}.png`);
    const model = applyLines(emptyModel(), [
      assistant("m", [{ type: "text", text: files.map((file) => `[${file}](${file})`).join(" ") }]),
    ]);
    const [extras] = answerExtras(model.items, model.tools, "/p", "/p", true).values();
    expect(extras?.files).toEqual(files.map((file) => `/p/${file}`));
  });

  test("an image file read again shows once, and one the answer links is left to its card", () => {
    seq = 0;
    const read = (id: string, path: string, data: string): ChatLine[] => [
      assistant(`a-${id}`, [{ type: "tool_use", id, name: "Read", input: { file_path: path } }]),
      out({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data } },
              ],
            },
          ],
        },
      }),
    ];
    const model = applyLines(emptyModel(), [
      {
        seq: ++seq,
        dir: "in",
        message: { type: "user", message: { role: "user", content: "draw the mockup" } },
      },
      ...read("r1", "/tmp/mock.png", "AAAA"),
      ...read("r2", "/tmp/shot.png", "BBBB"),
      ...read("r3", "/tmp/mock.png", "CCCC"),
      assistant("m", [{ type: "text", text: "Here it is: [mockup](/tmp/mock.png)." }]),
    ]);
    const images = (cardsAnywhere: boolean) => {
      const [extras] = answerExtras(
        model.items,
        model.tools,
        "/p",
        "/p",
        true,
        cardsAnywhere,
      ).values();
      return extras?.images.map(({ image, file }) => [image.data, file]);
    };
    expect(images(false)).toEqual([
      ["BBBB", "/tmp/shot.png"],
      ["CCCC", "/tmp/mock.png"],
    ]);
    expect(images(true)).toEqual([["BBBB", "/tmp/shot.png"]]);
  });

  test("files sent the user, and images a reply shows, are results with no card of their own", () => {
    seq = 0;
    const ask: ChatLine = {
      seq: ++seq,
      dir: "in",
      message: { type: "user", message: { role: "user", content: "send me the chart" } },
    };
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
    expect(resultsOf(model.items, model.tools, "/p")).toEqual([
      { kind: "file", target: "out/chart.png", created: false },
      { kind: "file", target: "/tmp/report.pdf", created: false },
      { kind: "file", target: "out/plot.png", created: false },
      { kind: "file", target: "notes.md", created: false },
    ]);
    const [extras] = answerExtras(model.items, model.tools, "/p", "/p", true).values();
    expect(extras.files).toEqual(["/p/notes.md"]);
    expect(outsideLinksOf(model.items, model.tools, "/p", "/p").files).toEqual(["/tmp/report.pdf"]);
  });

  test("a file the agent changed on a network share is told as one; a link to a share never is", () => {
    seq = 0;
    const edit = (id: string, file_path: string) => ({
      type: "tool_use",
      id,
      name: "Edit",
      input: { file_path },
    });
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        {
          type: "tool_use",
          id: "w",
          name: "Write",
          input: { file_path: "\\\\localhost\\C$\\tmp\\x\\unc.txt", content: "x" },
        },
        edit("ip", "//127.0.0.1/C$/tmp/x/ip.txt"),
        edit("bad", "\\\\denied\\share\\x.txt"),
        edit("dev", "\\\\?\\C:\\tmp\\device.txt"),
        edit("dot", "\\\\.\\pipe\\x"),
        edit("up", "\\\\localhost\\C$\\tmp\\..\\..\\D$\\up.txt"),
        edit("drive", "C:\\tmp\\out\\drive.txt"),
        edit("busy", "\\\\pending\\share\\x.txt"),
        { type: "tool_use", id: "r", name: "Read", input: { file_path: "\\\\read\\share\\a.txt" } },
        { type: "text", text: "See [it](\\\\linked\\share\\a.png) and `//linked/share/b.txt`." },
      ]),
      result("w", "ok", { type: "create", filePath: "\\\\localhost\\C$\\tmp\\x\\unc.txt" }),
      result("ip", "ok", {}),
      out({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "bad", content: "denied", is_error: true }],
        },
      }),
      result("dev", "ok", {}),
      result("dot", "ok", {}),
      result("up", "ok", {}),
      result("drive", "ok", {}),
      result("r", "ok", {}),
    ]);
    const shared = ["//localhost/C$/tmp/x/unc.txt", "//127.0.0.1/C$/tmp/x/ip.txt"];
    expect(changedShareFiles(model.tools, "C:\\p")).toEqual(shared);
    expect(changedShareFiles(model.tools, "\\\\localhost\\C$\\tmp\\x")).toEqual([shared[1]]);
    expect(changedShareFiles(model.tools, "/Users/me/p")).toEqual([]);
    const links = outsideLinksOf(model.items, model.tools, "C:\\p", "C:\\p");
    expect(links.files).toContain("/localhost/C$/tmp/x/unc.txt");
    expect(links.files.filter((file) => file.startsWith("//"))).toEqual([]);
  });

  test("grants what the user looked at, what tools did and the images an answer names, no other file it names", () => {
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/tmp/shot.png" } },
        { type: "tool_use", id: "r2", name: "Read", input: { file_path: "/p/src/a.ts" } },
        { type: "tool_use", id: "w", name: "Write", input: { file_path: "/tmp/site/index.html" } },
        { type: "tool_use", id: "n", name: "NotebookEdit", input: { notebook_path: "../n.ipynb" } },
        { type: "tool_use", id: "run", name: "Read", input: { file_path: "/tmp/running.txt" } },
      ]),
      result("r1", "ok", {}),
      result("r2", "ok", {}),
      result("w", "ok", { type: "create" }),
      result("n", "ok", {}),
      assistant("m2", [
        {
          type: "text",
          text: "See [report](/var/out/report.htm), `docs/b.md`, [key](/home/u/.ssh/id_rsa), ![shot](/tmp/s/shot.png), [svg](/tmp/s/plot.svg), [jpg](/tmp/s/a.JPG) and [share](\\\\host\\share\\x.png).",
        },
      ]),
    ]);
    const links = outsideLinksOf(model.items, model.tools, "/home/u/p", "/home/u/p", [
      "/x/y.pdf",
      "/home/u/p/inside.txt",
    ]);
    expect(links).toEqual({
      files: [
        "/x/y.pdf",
        "/tmp/shot.png",
        "/p/src/a.ts",
        "/tmp/site/index.html",
        "/home/u/n.ipynb",
        "/tmp/s/shot.png",
        "/tmp/s/plot.svg",
        "/tmp/s/a.JPG",
      ],
      opened: [],
    });
    expect(outsideLinksOf(model.items, model.tools, "/home/u/p", "")).toEqual({
      files: [],
      opened: [],
    });
  });

  test("an automount image in an answer is granted only once the user opens it", () => {
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        {
          type: "text",
          text: "![a](/net/host.example/share/a.png) ![b](/Network/Servers/host.example/b.png) ![c](/System/Volumes/Data/net/h/c.png) ![d](/tmp/d.png)",
        },
      ]),
    ]);
    expect(outsideLinksOf(model.items, model.tools, "/p", "/p")).toEqual({
      files: ["/tmp/d.png"],
      opened: [],
    });
    expect(
      outsideLinksOf(model.items, model.tools, "/p", "/p", [], undefined, [
        "/net/host.example/share/a.png",
        "/p/inside.png",
      ]),
    ).toEqual({ files: ["/tmp/d.png"], opened: ["/net/host.example/share/a.png"] });
  });

  test("a tool call that failed, was denied or was stopped grants nothing", () => {
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        { type: "tool_use", id: "fail", name: "Read", input: { file_path: "/home/u/.ssh/id_rsa" } },
        { type: "tool_use", id: "sent", name: "SendUserFile", input: { files: ["/etc/shadow"] } },
      ]),
      out({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "fail", content: "blocked", is_error: true },
            { type: "tool_result", tool_use_id: "sent", content: "denied", is_error: true },
          ],
        },
      }),
    ]);
    expect(model.tools.fail.status).toBe("error");
    const denied = { ...model.tools.fail, id: "d", status: "denied" as const };
    const stopped = { ...model.tools.fail, id: "s", status: "stopped" as const };
    const tools = { ...model.tools, d: denied, s: stopped };
    expect(outsideLinksOf(model.items, tools, "/p", "/p").files).toEqual([]);
  });

  test("the files a host serves its other devices are as before: links and every tool call too", () => {
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        { type: "tool_use", id: "fail", name: "Read", input: { file_path: "/tmp/failed.png" } },
        { type: "text", text: "See [report](/var/out/report.htm)." },
      ]),
      out({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "fail", content: "no", is_error: true }],
        },
      }),
    ]);
    expect(hostedOutsideFiles(model.items, model.tools, "/p", "/p")).toEqual([
      "/tmp/failed.png",
      "/var/out/report.htm",
    ]);
    expect(outsideLinkedFiles(model.items, model.tools, "/p", "/p")).toEqual([
      "/var/out/report.htm",
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
    expect(
      usageLimitsOf({
        rate_limits: {
          five_hour: { utilization: 5, resets_at: "2026-11-16T05:20:00.000Z" },
          seven_day: { utilization: 78, resets_at: "2026-11-19T14:00:00.000Z" },
          limits: [
            {
              kind: "weekly_scoped",
              percent: 3,
              resets_at: "2026-11-19T14:00:00.000Z",
              scope: { model: { display_name: "Fable" } },
            },
          ],
        },
      }),
    ).toEqual([
      { kind: "session", percent: 5, resetsAt: "2026-11-16T05:20:00.000Z", active: false },
      { kind: "weekly_all", percent: 78, resetsAt: "2026-11-19T14:00:00.000Z", active: false },
      {
        kind: "weekly_scoped",
        scope: "Fable",
        percent: 3,
        resetsAt: "2026-11-19T14:00:00.000Z",
        active: false,
      },
    ]);
  });
});

describe("links written from where the agent's shell went", () => {
  test("a card for each place a relative link may name, and a grant for each image place", () => {
    seq = 0;
    const model = applyLines(emptyModel(), [
      {
        seq: ++seq,
        dir: "in",
        message: { type: "user", message: { role: "user", content: "plot it" } },
      },
      assistant("m1", [
        {
          type: "tool_use",
          id: "b",
          name: "Bash",
          input: { command: "cd /p/tracks/P && python run.py && cd /tmp/x" },
        },
      ]),
      result("b", "ok", undefined),
      assistant("m2", [{ type: "text", text: "See [plot](outputs/a.png) and [log](/p/run.log)." }]),
    ]);
    const [extras] = answerExtras(model.items, model.tools, "/p", "/p", true).values();
    expect(extras.files).toEqual(["/p/outputs/a.png", "/p/run.log"]);
    expect(extras.elsewhere).toEqual({
      "/p/outputs/a.png": ["/tmp/x/outputs/a.png", "/p/tracks/P/outputs/a.png"],
    });
    expect(outsideLinksOf(model.items, model.tools, "/p", "/p").files).toEqual([
      "/tmp/x/outputs/a.png",
    ]);
    expect(outsideLinkedFiles(model.items, model.tools, "/p", "/p")).toEqual([
      "/tmp/x/outputs/a.png",
    ]);
  });
});

describe("distinctResults", () => {
  test("a percent-encoded link and the file it names share one result", () => {
    seq = 0;
    const model = applyLines(emptyModel(), [
      assistant("m1", [
        {
          type: "tool_use",
          id: "w",
          name: "Write",
          input: { file_path: "C:/p/My Report.md", content: "report" },
        },
      ]),
      result("w", "ok", { type: "create" }),
      assistant("m2", [
        {
          type: "text",
          text: "[report](my%20report.md:3), [report](<C:/p/My Report.md>), [notes](Review%20Notes.md), [site](https://example.com/My%20Report.md).",
        },
      ]),
    ]);
    const cwd = "C:/p";
    const results = resultsOf(model.items, model.tools, cwd);
    expect(results.map(({ target }) => target)).toContain("my%20report.md:3");
    expect(distinctResults(results, cwd)).toEqual([
      { kind: "file", target: "C:/p/My Report.md", created: true },
      { kind: "file", target: "Review%20Notes.md", created: false },
      { kind: "url", target: "https://example.com/My%20Report.md", created: false },
    ]);
    expect(resultFiles(results, cwd)).toContain("C:/p/Review Notes.md");
  });

  test("a file is the one found for its target, when that is given", () => {
    const found: Record<string, string> = { "a.png": "/p/P/a.png", "/p/P/a.png": "/p/P/a.png" };
    const results = distinctResults(
      [
        { kind: "file", target: "a.png", created: false },
        { kind: "file", target: "/p/P/a.png", created: true },
      ],
      "/p",
      (target) => found[target] ?? null,
    );
    expect(results).toEqual([{ kind: "file", target: "a.png", created: true }]);
  });

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

describe("the subagents of a history", () => {
  const history: ChatModel = {
    ...emptyModel(),
    items: [
      {
        kind: "assistant",
        key: "a1",
        messageId: "m1",
        blocks: [
          { type: "tool", toolUseId: "sync" },
          { type: "tool", toolUseId: "async" },
          { type: "tool", toolUseId: "cut" },
        ],
        at: 1_000,
      },
      {
        kind: "task_end",
        key: "te-t1",
        taskId: "t1",
        status: "failed",
        toolUseId: "async",
        at: 9_000,
      },
    ],
    tools: {
      sync: {
        id: "sync",
        name: "Agent",
        input: { description: "Plan it", subagent_type: "Plan" },
        status: "done",
        parentToolUseId: null,
        result: {
          text: "",
          isError: false,
          images: [],
          structured: { status: "completed", agentId: "a1", totalDurationMs: 4_000 },
        },
      },
      async: {
        id: "async",
        name: "Agent",
        input: { description: "Look around", run_in_background: true },
        status: "done",
        parentToolUseId: null,
        result: {
          text: "",
          isError: false,
          images: [],
          structured: { status: "async_launched", agentId: "a2" },
        },
      },
      cut: {
        id: "cut",
        name: "Agent",
        input: { description: "Cut short" },
        status: "running",
        parentToolUseId: null,
      },
    },
  };

  test("take their times from the conversation, and how they ended from its news", () => {
    const rows = pastAgentsOf(history);
    expect(rows.map((row) => [row.toolUseId, row.status, row.startedAt, row.endedAt])).toEqual([
      ["sync", "completed", 1_000, 5_000],
      ["async", "failed", 1_000, 9_000],
      ["cut", "stopped", 1_000, undefined],
    ]);
    expect(rows[0]).toMatchObject({ description: "Plan it", subagentType: "Plan" });
  });

  test("come before the program's own and its runs, each once", () => {
    const past = pastAgentsOf(history);
    const live = agentsOf({ ...emptyModel(), tools: { sync: history.tools.sync } });
    const runs = [{ ...live[0], toolUseId: "print:r" }];
    expect(joinAgents(past, live, runs).map((row) => row.toolUseId)).toEqual([
      "async",
      "cut",
      "sync",
      "print:r",
    ]);
    expect(joinAgents([], live, [])).toBe(live);
  });
});

describe("imagesOf", () => {
  const image = (data: string): ImageBlock => ({ mediaType: "image/png", data });
  const read = (id: string, images: ImageBlock[]): ToolCall =>
    ({
      id,
      name: "Read",
      status: "done",
      input: { file_path: "/tmp/x.png" },
      result: { images },
    }) as unknown as ToolCall;
  const turn = (ids: string[]): ChatItem =>
    ({
      kind: "assistant",
      blocks: ids.map((toolUseId) => ({ type: "tool", toolUseId })),
    }) as unknown as ChatItem;

  test("keeps each read of one file as its own image, in order", () => {
    const [a, b, c] = [image("a"), image("b"), image("c")];
    const tools = { t1: read("t1", [a]), t2: read("t2", [b]), t3: read("t3", [c]) };
    const shown = imagesOf([turn(["t1", "t2", "t3"])], tools, "/tmp");
    expect(shown).toEqual([
      { file: "/tmp/x.png", image: a },
      { file: "/tmp/x.png", image: b },
      { file: "/tmp/x.png", image: c },
    ]);
    expect(shown[1].image).toBe(b);
  });

  test("lists a block only once, however often it is walked", () => {
    const a = image("a");
    const shown = imagesOf([turn(["t1", "t1"])], { t1: read("t1", [a]) }, "/tmp");
    expect(shown).toHaveLength(1);
  });
});

describe("imagesOf, the images a chat shows in full", () => {
  const image = (data: string): ImageBlock => ({ mediaType: "image/png", data });
  const tool = (id: string, name: string, input: unknown, images: ImageBlock[] = []): ToolCall =>
    ({ id, name, status: "done", input, result: { text: "", isError: false, images } }) as ToolCall;
  const turn = (blocks: unknown[]): ChatItem =>
    ({ kind: "assistant", blocks }) as unknown as ChatItem;

  test("marks the files sent to the user and shown in a reply as placed, not one only linked", () => {
    const tree = image("tree");
    const tools = {
      r: tool("r", "Read", { file_path: "/tmp/s/tree.png" }, [tree]),
      s: tool("s", "SendUserFile", { files: ["/tmp/s/tree.png", "/tmp/s/top.png"] }),
    };
    const shown = imagesOf(
      [
        turn([
          { type: "tool", toolUseId: "r" },
          { type: "tool", toolUseId: "s" },
          { type: "text", text: "![x](/tmp/s/shown.png) and [y](/tmp/s/linked.png)" },
        ]),
      ],
      tools,
      "/ws",
    );
    expect(shown).toEqual([
      { file: "/tmp/s/tree.png", image: tree, placed: true },
      { file: "/tmp/s/top.png", placed: true },
      { file: "/tmp/s/shown.png", placed: true },
      { file: "/tmp/s/linked.png" },
    ]);
  });

  test("places a file linked first once a later part shows it, where it first came", () => {
    const tools = { s: tool("s", "SendUserFile", { files: ["/tmp/s/a.png"] }) };
    const shown = imagesOf(
      [
        turn([
          { type: "text", text: "[a](/tmp/s/a.png)" },
          { type: "tool", toolUseId: "s" },
        ]),
      ],
      tools,
      "/ws",
    );
    expect(shown).toEqual([{ file: "/tmp/s/a.png", placed: true }]);
  });

  test("does not place what a send not yet done names", () => {
    const sending = {
      ...tool("s", "SendUserFile", { files: ["/tmp/s/a.png"] }),
      status: "running",
    };
    const shown = imagesOf(
      [turn([{ type: "tool", toolUseId: "s" }])],
      { s: sending as ToolCall },
      "/ws",
    );
    expect(shown).toEqual([{ file: "/tmp/s/a.png" }]);
  });
});

describe("images the user attached to a message", () => {
  const image = (data: string): ImageBlock => ({ mediaType: "image/png", data });
  const user = (text: string, images: ImageBlock[] = [], extra: object = {}): ChatItem =>
    ({ kind: "user", key: text, text, images, state: "taken", ...extra }) as ChatItem;
  const readCall = (id: string, path: string, images: ImageBlock[]): ToolCall =>
    ({
      id,
      name: "Read",
      status: "done",
      input: { file_path: path },
      result: { text: "", isError: false, images },
    }) as ToolCall;
  const turn = (ids: string[]): ChatItem =>
    ({
      kind: "assistant",
      blocks: ids.map((toolUseId) => ({ type: "tool", toolUseId })),
    }) as unknown as ChatItem;

  test("are its last paragraph's mentions of image files, from the chat's folder", () => {
    const sent = user(
      'look\n\n@/tmp/a/big.png @shots/b.webp @"/tmp/a/my shot.png" @/tmp/a/notes.txt',
    );
    expect(attachedImagesOf(sent as never, "/ws")).toEqual([
      "/tmp/a/big.png",
      "/ws/shots/b.webp",
      "/tmp/a/my shot.png",
    ]);
    expect(attachedImagesOf(user("see @/tmp/a/big.png here") as never, "/ws")).toEqual([]);
    const going = user("@/tmp/a/big.png", [], { optimistic: { fileNames: ["big.png"] } });
    expect(attachedImagesOf(going as never, "/ws")).toEqual([]);
  });

  test("come in quick look's list where the message is, after its pasted ones", () => {
    const [pasted, before, after] = [image("p"), image("b"), image("a")];
    const tools = {
      r1: readCall("r1", "/tmp/a/first.png", [before]),
      r2: readCall("r2", "/tmp/a/last.png", [after]),
    };
    const shown = imagesOf(
      [turn(["r1"]), user("here\n\n@/tmp/a/big.png @/tmp/a/notes.txt", [pasted]), turn(["r2"])],
      tools,
      "/ws",
    );
    expect(shown).toEqual([
      { file: "/tmp/a/first.png", image: before },
      { image: pasted },
      { file: "/tmp/a/big.png" },
      { file: "/tmp/a/last.png", image: after },
    ]);
  });

  const tab: RelaySender = { kind: "tab", agent: "claude", name: "Other", tabId: "t2" };
  const relayed = (text: string) => user(relayedText(tab, text));

  test("in a chat here, are looked up: one there keeps its place, one removed with its tab is left out", async () => {
    const [before, after] = [image("b"), image("a")];
    const tools = {
      r1: readCall("r1", "/tmp/a/first.png", [before]),
      r2: readCall("r2", "/tmp/a/last.png", [after]),
    };
    const kept = "/h/.nexus-code/attach/w1/c1/1/kept.png";
    const removed = "/h/.nexus-code/attach/w1/old/1/removed.png";
    const items = [turn(["r1"]), user(`@${removed}`), user(`see\n\n@${kept}`), turn(["r2"])];
    const shown = imagesOf(items, tools, "/ws");
    expect(attachedFilesIn(items, "/ws")).toEqual([removed, kept]);
    const asked: string[][] = [];
    const look = await lookAtImage(
      shown,
      { file: "/tmp/a/last.png", image: after },
      async (files) => {
        asked.push(files);
        return new Set([kept]);
      },
    );
    expect(asked).toEqual([[removed, kept]]);
    expect(look?.files).toEqual(["image:1", kept, "image:2"]);
    expect(look?.index).toBe(2);
  });

  test("are placed only where `served` says the files are served, as another computer's are", () => {
    const ours = "/h/.nexus-code/attach/w1/c1/1/shot.png";
    const items = [user(`@${ours} @/Users/me/Desktop/dropped.png`)];
    expect(imagesOf(items, {}, "/ws", {}, (file) => file === ours)).toEqual([
      { file: ours, placed: true },
      { file: "/Users/me/Desktop/dropped.png" },
    ]);
  });

  test("are none in a message another agent sent, whatever it names", () => {
    for (const text of ["look\n\n@/tmp/x.png", "@/etc/a.png"]) {
      expect(attachedImagesOf(relayed(text) as never, "/ws")).toEqual([]);
    }
    const shown = imagesOf([relayed("look\n\n@/tmp/x.png"), user("@/tmp/a/big.png")], {}, "/ws");
    expect(shown).toEqual([{ file: "/tmp/a/big.png" }]);
  });

  test("grants files from the user's attachment trailer individually", () => {
    const items = [
      user("@/tmp/a/big.png @/tmp/a/notes.txt @/tmp/a/report.html"),
      user("@/tmp/a/folder/"),
      user("read @/tmp/a/inline.md"),
      user("@/ws/inside.png"),
      relayed("look\n\n@/tmp/x.png"),
      relayed("@/etc/a.pdf"),
    ];
    expect(outsideLinksOf(items, {}, "/ws", "/ws")).toEqual({
      files: ["/tmp/a/big.png", "/tmp/a/notes.txt", "/tmp/a/report.html"],
      opened: [],
    });
  });

  test("are granted, where another device reads them, only as `attached` lets them", () => {
    const ours = "/Users/me/.nexus-code/attach/w1/c1/1/shot.png";
    const items = [user(`@${ours}`), user("@/tmp/a/big.png")];
    const tools = { r1: readCall("r1", "/tmp/a/read.png", [image("r")]) };
    const files = outsideLinksOf(items, tools, "/ws", "/ws", [], (file) => file === ours).files;
    expect(files.sort()).toEqual([ours, "/tmp/a/read.png"].sort());
  });
});
