import { describe, expect, test } from "bun:test";
import { ChatPanelSchema, MAX_HELD_TEXT } from "../../../../../packages/remote-protocol/src";
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
          categories: [
            { name: "Messages", tokens: 1200, kind: "used" },
            { name: "Free space", tokens: 198_800, kind: "free" },
          ],
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
    expect(panel.context).toEqual({
      usedTokens: 1200,
      maxTokens: 200_000,
      categories: [{ name: "Messages", tokens: 1200 }],
      freeTokens: 198_800,
    });
    expect(panel.costUsd).toBe(0.42);
    expect(panel.goal).toEqual({
      condition: "tests pass",
      status: "active",
      setAt: 5,
      checks: 1,
      checkReasons: [{ reason: "no" }],
    });
    expect(panel).toMatchObject({ tasks: [], agents: [] });
  });

  test("streams reuse changed-file summaries until the tool map changes", () => {
    const first = chatPanelOf(source({ tools }, "codex")).changedFiles;
    expect(chatPanelOf(source({ tools, running: true }, "codex")).changedFiles).toBe(first);
    const added = call(
      "new",
      "Write",
      { file_path: "/p/b.ts", content: "new" },
      {
        result: { text: "", images: [], isError: false, structured: { type: "create" } },
      },
    );
    const next = chatPanelOf(source({ tools: { ...tools, new: added } }, "codex")).changedFiles;
    expect(next).toContainEqual({ path: "/p/b.ts", added: 1, removed: 0, created: true });
    expect(first).toHaveLength(1);
  });

  test("a background run tells where its output is written: as its end said, or its start", () => {
    const bash = call(
      "bash",
      "Bash",
      { command: "make", run_in_background: true },
      {
        result: {
          text: "Command running in background with ID: b2. Output is being written to: /tmp/c/b2.output.",
          isError: false,
          images: [],
        },
      },
    );
    const panel = chatPanelOf(
      source({
        tools: { bash },
        tasks: {
          b1: {
            taskId: "b1",
            type: "local_bash",
            description: "ended",
            status: "completed",
            outputFile: "/tmp/c/b1.output",
          },
          b2: {
            taskId: "b2",
            type: "local_bash",
            description: "running",
            status: "running",
            toolUseId: "bash",
          },
        },
      }),
    );
    expect(panel.tasks.map((t) => [t.taskId, t.outputFile])).toEqual([
      ["b1", "/tmp/c/b1.output"],
      ["b2", "/tmp/c/b2.output"],
    ]);
  });

  test("a file the chat made is told as made", () => {
    const write = call(
      "write",
      "Write",
      { file_path: "/p/new.ts", content: "x\ny" },
      { result: { text: "", isError: false, images: [], structured: { type: "create" } } },
    );
    const panel = chatPanelOf(source({ tools: { ...tools, write } }));
    expect(panel.changedFiles).toEqual([
      { path: "/p/a.ts", added: 1, removed: 2 },
      { path: "/p/new.ts", added: 2, removed: 0, created: true },
    ]);
  });

  test("a changed file keeps the spelling its first change named where it differs (0.34.0)", () => {
    const unc = call(
      "unc",
      "Edit",
      { file_path: "\\\\server\\share\\x.ts" },
      { result: { text: "", isError: false, images: [], structured: {} } },
    );
    const again = call(
      "again",
      "Edit",
      { file_path: "//server/share/x.ts" },
      { result: { text: "", isError: false, images: [], structured: {} } },
    );
    const panel = chatPanelOf(source({ tools: { ...tools, unc, again } }));
    expect(panel.changedFiles).toEqual([
      { path: "/p/a.ts", added: 1, removed: 2 },
      { path: "//server/share/x.ts", rawPath: "\\\\server\\share\\x.ts", added: 0, removed: 0 },
    ]);
  });

  test("an ended goal's checks, the last that ended it too", () => {
    const panel = chatPanelOf(
      source({
        goal: {
          condition: "say ok",
          status: "met",
          setAt: 5,
          checks: [],
          iterations: 1,
          endedLive: true,
        },
      }),
    );
    expect(panel.goal).toMatchObject({ status: "met", checks: 0, iterations: 1 });
  });

  test("a Claude chat's limit, MCP servers, program and Remote Control", () => {
    const panel = chatPanelOf(
      source({
        sessionId: "s-1",
        version: "2.9.0",
        rateLimit: { status: "allowed_warning", resetsAt: 1_700, rateLimitType: "five_hour" },
        mcp: [{ name: "docs", status: "connected", scope: "user" }],
        init: {
          commands: [],
          models: [],
          remoteControl: true,
          account: { email: "a@example.com", subscription: "max", provider: "firstParty" },
        },
        remoteControl: { enabled: true, sessionUrl: "https://claude.ai/code/s-1" },
      }),
    );
    expect(panel).toMatchObject({
      rateLimit: { status: "allowed_warning", resetsAt: 1_700_000, kind: "five_hour" },
      mcp: [{ name: "docs", status: "connected", scope: "user" }],
      session: { id: "s-1", version: "2.9.0", account: "a@example.com · max" },
      remoteControl: { available: true, enabled: true, url: "https://claude.ai/code/s-1" },
    });
    const codex = chatPanelOf(source({ sessionId: "x" }, "codex"));
    for (const key of ["rateLimit", "mcp", "session", "remoteControl", "can"]) {
      expect(codex).not.toHaveProperty(key);
    }
  });

  test("Codex publishes its actual checklist, thread environment and read-only MCP inventory", () => {
    const base = source(
      {
        threadId: "thread-1",
        appServerVersion: "0.166.0",
        account: { type: "chatgpt" },
        plan: [{ content: "Check the changes", status: "in_progress" }],
        mcpServers: [
          { name: "issues", status: "failed", needsLogin: true, tools: 0 },
          { name: "docs", status: "connected", tools: 2 },
          { name: "off", status: "disabled", needsLogin: true, tools: 0 },
        ],
      },
      "codex",
    );
    const before = sentOf(base, 0);
    const withControls = { ...base, can: { rewind: false, fork: false, background: false } };
    const after = sentOf(withControls, 0);
    const wire = ChatPanelSchema.parse(JSON.parse(after.panel));
    expect(wire.todos).toEqual([{ content: "Check the changes", status: "in_progress" }]);
    expect(wire.session).toEqual({ id: "thread-1", version: "0.166.0", account: "chatgpt" });
    expect(wire.mcp).toEqual([
      { name: "issues", status: "needs-auth" },
      { name: "docs", status: "connected" },
      { name: "off", status: "disabled" },
    ]);
    expect(wire.can?.mcpStatus).toBe(true);
    expect(wire.can?.mcp).toBeUndefined();
    expect(changesOf(before, after, true)?.panel).toEqual(wire);
  });

  test("where it went on in another profile, by the item each move follows", () => {
    const items = [
      { kind: "user", key: "u1", uuid: "m1", text: "hi", images: [], state: "taken" },
      { kind: "assistant", key: "a1", uuid: "m2", blocks: [{ type: "text", text: "yo" }] },
    ];
    const panel = chatPanelOf({
      ...source({ items }),
      moves: [
        { after: "m2", profile: "work", at: 9 },
        { after: "gone", profile: "home", at: 10 },
      ],
      can: { rewind: true, fork: true, background: true, moveNow: true },
    });
    expect(panel.moves).toEqual([{ after: "a1", profile: "work", at: 9 }]);
    expect(panel.can).toEqual({
      rewind: true,
      fork: true,
      background: true,
      moveNow: true,
      clientNonce: true,
    });
  });

  test("the messages held for after the turn, each's text cut short, and its images counted", () => {
    const long = "x".repeat(MAX_HELD_TEXT + 20);
    const base = source({});
    const panel = chatPanelOf({
      ...base,
      chat: {
        ...base.chat,
        queue: [
          { id: "q1", text: "short", images: [] },
          { id: "q2", text: long, images: [{ mediaType: "image/png", data: "AA" }] },
        ],
      },
    } as Parameters<typeof chatPanelOf>[0]);
    expect(panel.held).toEqual([
      { id: "q1", text: "short" },
      { id: "q2", text: long.slice(0, MAX_HELD_TEXT), truncated: true, images: 1 },
    ]);
    expect(chatPanelOf(source({})).held).toBeUndefined();
  });

  test("a Claude chat's context is none while its window is unknown or 0", () => {
    const counted = (window: Record<string, unknown>) =>
      chatPanelOf(
        source({
          contextUsage: {
            categories: [{ name: "Messages", tokens: 1200, kind: "used" }],
            totalTokens: 1200,
            percentage: 0,
            ...window,
          },
        }),
      ).context;
    expect(counted({})).toBeNull();
    expect(counted({ maxTokens: 0 })).toBeNull();
    expect(counted({ maxTokens: "200000" })).toBeNull();
    expect(counted({ maxTokens: 200_000 })).toMatchObject({ usedTokens: 1200, maxTokens: 200_000 });
    expect(chatPanelOf(source({})).context).toBeNull();
  });

  test("a Codex chat's context is its tokens; none before it told them", () => {
    expect(chatPanelOf(source({ tokens: { used: 10, window: 100 } }, "codex")).context).toEqual({
      usedTokens: 10,
      maxTokens: 100,
    });
    expect(chatPanelOf(source({ tokens: { used: 10, window: 0 } }, "codex")).context).toBeNull();
    expect(chatPanelOf(source({ tokens: { used: 10 } }, "codex")).context).toBeNull();
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
    const plan = {
      rate_limits: { limits: [{ kind: "session", percent: 80, is_active: true }] },
    };
    expect(planLimitsOf({ ...source({ usage }), plan: { claude: plan } }, now)).toEqual([
      { kind: "session", percent: 80 },
    ]);
    expect(planLimitsOf(source({ usage }), Date.parse("2026-11-15T11:00:00Z"))).toHaveLength(2);
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

  test("when its app goes on after the usage limit, while it waits; none once the message went", () => {
    const record = {
      stopAt: 1,
      resetsAt: 2,
      at: 60_002,
      state: "waiting" as const,
      tries: 1,
      session: "s",
    };
    expect(chatPanelOf({ ...source({}), limitResume: record }).limitResume).toEqual({
      state: "waiting",
      stopAt: 1,
      at: 60_002,
      resetsAt: 2,
      tries: 1,
    });
    const sent = { ...record, state: "sent" as const, sentAt: 60_002 };
    expect(chatPanelOf({ ...source({}), limitResume: sent }).limitResume).toBeUndefined();
  });
});
