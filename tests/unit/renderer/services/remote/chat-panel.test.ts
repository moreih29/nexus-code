/** A chat's side panel as another device reads it, and a watch sending it as it changes. */
import { describe, expect, test } from "bun:test";
import type { ChatModel, ToolCall } from "../../../../../src/renderer/services/chat/model";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { chatPanelOf } from "../../../../../src/renderer/services/remote/chat-panel";
import { changesOf, sentOf } from "../../../../../src/renderer/services/remote/chat-watch";

const call = (
  id: string,
  name: string,
  input: unknown,
  over: Partial<ToolCall> = {},
): ToolCall => ({
  id,
  name,
  input,
  status: "done",
  parentToolUseId: null,
  ...over,
});

const source = (
  model: Partial<ChatModel> & Record<string, unknown>,
  agent: "claude" | "codex" = "claude",
) => ({
  agent,
  title: "T",
  chat: { ...emptyTabState(), model: { ...emptyModel(), ...model } as ChatModel },
});

const tools = {
  todo: call("todo", "TodoWrite", {
    todos: [
      { content: "read", status: "completed" },
      { content: "fix", status: "in_progress" },
    ],
  }),
  edit: call(
    "edit",
    "Edit",
    { file_path: "/p/a.ts", old_string: "a\nb", new_string: "c" },
    {
      result: {
        text: "",
        isError: false,
        images: [],
        structured: { structuredPatch: [{ lines: ["-a", "-b", "+c"] }] },
      },
    },
  ),
};

describe("a chat's side panel", () => {
  test("its to-dos, changed files, context, cost and goal", () => {
    const panel = chatPanelOf(
      source({
        tools,
        costUsd: 0.42,
        contextUsage: {
          categories: [{ name: "Messages", tokens: 1200, kind: "used" }],
          totalTokens: 1200,
          maxTokens: 200_000,
        },
        goal: { condition: "tests pass", status: "active", setAt: 5, checks: [{ reason: "no" }] },
      }),
    );
    expect(panel.todos).toEqual([
      { content: "read", status: "completed" },
      { content: "fix", status: "in_progress" },
    ]);
    expect(panel.changedFiles).toEqual([{ path: "/p/a.ts", added: 1, removed: 2 }]);
    expect(panel.context).toEqual({ usedTokens: 1200, maxTokens: 200_000 });
    expect(panel.costUsd).toBe(0.42);
    expect(panel.goal).toEqual({ condition: "tests pass", status: "active", setAt: 5, checks: 1 });
    expect(panel).toMatchObject({ tasks: [], agents: [] });
  });

  test("a Codex chat's context is its tokens; none before it told them", () => {
    expect(chatPanelOf(source({ tokens: { used: 10, window: 100 } }, "codex")).context).toEqual({
      usedTokens: 10,
      maxTokens: 100,
    });
    expect(chatPanelOf(source({}, "codex"))).toMatchObject({ context: null, goal: null });
  });

  test("a watch sends it when it changed, and only then", () => {
    const before = source({ tools: { todo: tools.todo } });
    const same = source({ tools: { todo: tools.todo } });
    expect(changesOf(sentOf(before, 0), sentOf(same, 0))).toBeNull();
    const after = source({ tools, costUsd: 1 });
    expect(changesOf(sentOf(before, 0), sentOf(after, 0))?.panel).toMatchObject({
      costUsd: 1,
      changedFiles: [{ path: "/p/a.ts" }],
    });
  });
});
