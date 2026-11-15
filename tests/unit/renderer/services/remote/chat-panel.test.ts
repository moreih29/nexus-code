/** A chat's side panel as another device reads it, and a watch sending it as it changes. */
import { describe, expect, test } from "bun:test";
import type { ChatModel, ToolCall } from "../../../../../src/renderer/services/chat/model";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { chatPanelOf, planLimitsOf } from "../../../../../src/renderer/services/remote/chat-panel";
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

  test("tells the plan's usage limits as the composer's line does, and none without a plan", () => {
    const now = Date.parse("2026-11-15T09:00:00Z");
    const usage = {
      rate_limits: {
        limits: [
          { kind: "session", percent: 65, resets_at: "2026-11-15T10:00:00Z", is_active: true },
          { kind: "weekly_all", percent: 41, resets_at: "2026-11-19T01:00:00Z", is_active: false },
          {
            kind: "weekly_scoped",
            percent: 12,
            scope: { model: { display_name: "Opus" } },
            is_active: false,
          },
        ],
      },
    };
    expect(chatPanelOf(source({ usage }), now).planLimits).toEqual([
      { kind: "session", percent: 65, resetsAt: Date.parse("2026-11-15T10:00:00Z") },
      { kind: "weekly", percent: 41, resetsAt: Date.parse("2026-11-19T01:00:00Z") },
      { kind: "weekly_scoped", scope: "Opus", percent: 12 },
    ]);
    // The profile's, as this app last heard it, before what the program last told the tab.
    const plan = {
      rate_limits: { limits: [{ kind: "session", percent: 80, is_active: true }] },
    };
    expect(planLimitsOf({ ...source({ usage }), plan: { claude: plan } }, now)).toEqual([
      { kind: "session", percent: 80 },
    ]);
    // A window that started over since is left out till the next answer.
    expect(planLimitsOf(source({ usage }), Date.parse("2026-11-15T11:00:00Z"))).toHaveLength(2);
    // Paid by API key: no limits, and the cost tells it.
    const byKey = chatPanelOf(source({ costUsd: 0.42 }), now);
    expect(byKey).not.toHaveProperty("planLimits");
    expect(byKey.costUsd).toBe(0.42);
  });

  test("a Codex tab's limits are its windows, the week's named so", () => {
    const now = 1_000_000;
    const rateLimits = {
      primary: { usedPercent: 30, windowMins: 300, resetsAt: 2_000 },
      secondary: { usedPercent: 55, windowMins: 7 * 24 * 60 },
    };
    expect(planLimitsOf(source({ rateLimits }, "codex"), now)).toEqual([
      { kind: "window", windowMins: 300, percent: 30, resetsAt: 2_000_000 },
      { kind: "weekly", percent: 55 },
    ]);
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
