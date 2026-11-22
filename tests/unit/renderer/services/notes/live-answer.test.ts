import { expect, mock, spyOn, test } from "bun:test";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { ChatController } from "../../../../../src/renderer/services/chat/claude/controller";
import { CodexController } from "../../../../../src/renderer/services/chat/codex/controller";
import { type ChatModel, emptyModel } from "../../../../../src/renderer/services/chat/model";
import { changedFilesOf } from "../../../../../src/renderer/services/chat/panel";
import { emptyTabState, useChatStore } from "../../../../../src/renderer/services/chat/store";
import {
  historicalAnswerOf,
  liveAnswerOf,
  loadedAnswerOf,
} from "../../../../../src/renderer/services/notes/live-answer";
import {
  LIVE_ANSWER_CLOCK_TOLERANCE_MS,
  liveAnswerPreview,
} from "../../../../../src/shared/notes/links";

test("the preview flattens Markdown and stays the same when read again", () => {
  const markdown = [
    "# Heading",
    "",
    "> **Bold** and *italic*",
    "",
    "- [Label](https://example.com/path_(part))",
    "- ![Alt text](image.png)",
    "- `src/file.ts`",
    "",
    "```ts",
    "const count = 1;",
    "```",
  ].join("\n");
  const preview = "Heading Bold and italic Label · Alt text · src/file.ts const count = 1;";
  expect(liveAnswerPreview(markdown)).toBe(preview);
  expect(liveAnswerPreview(preview)).toBe(preview);
  expect(liveAnswerPreview("**[Label]**(https://example.com)")).toBe("Label");
  expect(liveAnswerPreview(`**${"a".repeat(499)}\uD800\u202e😀tail**`)).toBe(
    `${"a".repeat(499)}😀`,
  );
});

test("a snapshot is capped at 500 Unicode characters with no format controls", () => {
  const model: ChatModel = {
    ...emptyModel(),
    lastResult: { subtype: "success", isError: false, at: 100, turnId: "turn" },
    items: [
      {
        kind: "assistant",
        key: "answer",
        messageId: "answer",
        turnId: "turn",
        blocks: [
          { type: "thinking", text: "Private reasoning" },
          { type: "text", text: `${"a".repeat(499)}\u2066😀tail\u2069` },
          { type: "tool", toolUseId: "edit" },
          { type: "tool", toolUseId: "delete" },
          { type: "tool", toolUseId: "deleteEdited" },
        ],
      },
    ],
    tools: {
      edit: {
        id: "edit",
        name: "Edit",
        status: "done",
        parentToolUseId: null,
        input: { file_path: "one.ts" },
      },
      delete: {
        id: "delete",
        name: "Delete",
        status: "done",
        parentToolUseId: null,
        input: { file_path: "two.ts" },
      },
      deleteEdited: {
        id: "deleteEdited",
        name: "Delete",
        status: "done",
        parentToolUseId: null,
        input: { file_path: "one.ts" },
      },
    },
  };
  expect(liveAnswerOf(model)).toEqual({ text: `${"a".repeat(499)}😀`, at: 100, turnFiles: 2 });
  expect(changedFilesOf(model.tools).map(({ path }) => path)).toEqual(["one.ts"]);
  expect(liveAnswerOf({ ...model, running: true })).toBeUndefined();
  const now = spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const limit = 1_000 + LIVE_ANSWER_CLOCK_TOLERANCE_MS;
    const withResultAt = (at: number): ChatModel => ({
      ...model,
      lastResult: { subtype: "success", isError: false, at, turnId: "turn" },
    });
    expect(liveAnswerOf(withResultAt(limit))?.at).toBe(limit);
    expect(liveAnswerOf(withResultAt(limit + 1))?.at).toBe(1_000);
  } finally {
    now.mockRestore();
  }
});

test.each([
  "claude",
  "codex",
] as const)("publishes %s snapshots at live turn completion, excluding replay", (agent) => {
  const listen = spyOn(ipc, "ipcListen").mockReturnValue(() => {});
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue({ ok: true, value: undefined });
  const onTurnEnd = mock((model: ChatModel) => liveAnswerOf(model));
  const target = { workspaceId: "live-card", tabId: agent, cwd: "/repo" };
  const controller =
    agent === "claude"
      ? new ChatController({ ...target, sessionId: "thread" }, { onTurnEnd })
      : new CodexController({ ...target, threadId: "thread" }, { onTurnEnd });
  useChatStore.getState().update(controller.key, (state) => ({
    ...state,
    model: {
      ...state.model,
      process: "running",
      threadId: "thread",
      tasks:
        agent === "codex"
          ? {
              child: {
                taskId: "child",
                type: "codex_subagent",
                status: "running",
                description: "Child",
              },
            }
          : {},
    },
  }));
  let seq = 0;
  const line = (message: unknown, replay = false) =>
    controller.receive({
      dir: "out",
      seq: ++seq,
      at: seq * 100,
      message,
      replay,
    });
  const codex = (method: string, params: object, replay = false) =>
    line({ method, params: { threadId: "thread", ...params } }, replay);
  const turn = (id: string, replay: boolean, files: string[]) => {
    if (agent === "claude") {
      files.forEach((file, index) => {
        const tool = `${id}-edit-${index}`;
        line(
          {
            type: "assistant",
            message: {
              id: tool,
              content: [{ type: "tool_use", id: tool, name: "Edit", input: { file_path: file } }],
            },
          },
          replay,
        );
        line(
          {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: tool, content: "Done" }] },
          },
          replay,
        );
      });
      line({ type: "assistant", message: { id, content: [{ type: "text", text: id }] } }, replay);
      controller.flushNow();
      expect(onTurnEnd).not.toHaveBeenCalled();
      line({ type: "result", subtype: "success", is_error: false }, replay);
    } else {
      codex("turn/started", { turn: { id } }, replay);
      if (files.length) {
        codex(
          "item/completed",
          {
            turnId: id,
            item: {
              id: `${id}-patch`,
              type: "fileChange",
              status: "completed",
              changes: files.map((path) => ({ path, kind: { type: "add" } })),
            },
          },
          replay,
        );
      }
      codex("item/completed", { turnId: id, item: { id, type: "agentMessage", text: id } }, replay);
      controller.flushNow();
      expect(onTurnEnd).not.toHaveBeenCalled();
      codex("turn/completed", { turn: { id, status: "completed", items: [] } }, replay);
    }
    controller.flushNow();
  };
  try {
    turn("replayed answer", true, ["old.ts", "older.ts"]);
    expect(onTurnEnd).not.toHaveBeenCalled();
    if (agent === "codex") {
      codex("turn/completed", {
        threadId: "child",
        turn: {
          id: "child-turn",
          status: "completed",
          items: [{ type: "agentMessage", id: "child-answer", text: "Child answer" }],
        },
      });
      controller.flushNow();
      expect(onTurnEnd).not.toHaveBeenCalled();
      expect(useChatStore.getState().tabs[controller.key].model.tasks.child.status).toBe(
        "completed",
      );
    }
    turn("new answer", false, ["one.ts", "one.ts"]);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd.mock.results[0].value).toEqual({
      text: "new answer",
      at: seq * 100,
      turnFiles: 1,
    });
    onTurnEnd.mockClear();
    turn("no edits", false, []);
    expect(onTurnEnd.mock.results[0].value).toEqual({
      text: "no edits",
      at: seq * 100,
      turnFiles: 0,
    });
  } finally {
    controller.dispose();
    call.mockRestore();
    listen.mockRestore();
  }
});

test("Claude transcript previews count only edits after the answer's accepted prompt", () => {
  const prompt = (key: string) => ({
    kind: "user" as const,
    key,
    text: key,
    state: "taken" as const,
    images: [],
  });
  const answer = (key: string, toolUseId: string) => ({
    kind: "assistant" as const,
    key,
    messageId: key,
    at: 500,
    blocks: [
      { type: "tool" as const, toolUseId },
      { type: "text" as const, text: key },
    ],
  });
  const edit = (id: string) => ({
    id,
    name: "Edit",
    input: { file_path: id },
    status: "done" as const,
    parentToolUseId: null,
  });
  const model = {
    ...emptyModel(),
    items: [prompt("old"), answer("old answer", "old"), prompt("new"), answer("latest", "new")],
    tools: { old: edit("old"), new: edit("new") },
  };
  expect(historicalAnswerOf(model)).toEqual({ text: "latest", at: 500, turnFiles: 1 });
  expect(historicalAnswerOf({ ...model, items: model.items.slice(-1) })).toEqual({
    text: "latest",
    at: 500,
  });
});

test("a loaded tab can seed from history or the preceding answer while a turn runs", () => {
  const assistant = (text: string, at: number) => ({
    kind: "assistant" as const,
    key: text,
    messageId: text,
    at,
    blocks: [{ type: "text" as const, text }],
  });
  const history = { ...emptyModel(), items: [assistant("Restored answer", 100)] };
  const state = emptyTabState();
  expect(loadedAnswerOf({ ...state, history })).toEqual({ text: "Restored answer", at: 100 });
  expect(
    loadedAnswerOf({
      ...state,
      history,
      model: {
        ...state.model,
        running: true,
        turn: { startedAt: 300, outputTokens: 0, thinkingTokens: 0 },
        items: [assistant("Preceding answer", 200), assistant("Still streaming", 301)],
      },
    }),
  ).toEqual({ text: "Preceding answer", at: 200 });
});

test("live answer previews stop on deeply nested escapes", () => {
  const nested = `${"\\".repeat(40)}*${"&amp;".repeat(20)}*`;
  const preview = liveAnswerPreview(nested);
  expect(preview.length).toBeLessThanOrEqual(500);
  expect(liveAnswerPreview("**a** `b` [c](https://x.test)")).toBe("a b c");
});
