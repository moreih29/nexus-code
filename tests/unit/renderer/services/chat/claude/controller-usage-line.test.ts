import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sent: Record<string, unknown>[] = [];

const realIpc = await import("../../../../../../src/renderer/ipc/client");
mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (
    _channel: string,
    method: string,
    args: { message?: Record<string, unknown> },
  ) => {
    if (method === "send" && args.message) sent.push(args.message);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import(
  "../../../../../../src/renderer/services/chat/claude/controller"
);
const { useChatStore } = await import("../../../../../../src/renderer/services/chat/store");
const { resetPlanUsage } = await import("../../../../../../src/renderer/services/chat/plan-usage");
type ChatLine = import("../../../../../../src/renderer/services/chat/model").ChatLine;
type Controller = InstanceType<typeof ChatController>;

let seq = 0;
const live: Controller[] = [];

function running(version = "2.1.321"): Controller {
  const c = new ChatController({ workspaceId: "ws-usage", tabId: `t${++seq}`, cwd: "/p" }, {});
  useChatStore.getState().update(c.key, (prev) => ({
    ...prev,
    phase: "ready",
    version,
    model: { ...prev.model, process: "running" },
  }));
  live.push(c);
  return c;
}

const result = (replay = false): ChatLine => ({
  seq: ++seq,
  dir: "out",
  message: { type: "result", subtype: "success", is_error: false, session_id: "s1" },
  ...(replay ? { replay: true } : {}),
});

const callStart = (input: number, parent?: string): ChatLine => ({
  seq: ++seq,
  dir: "out",
  message: {
    type: "stream_event",
    event: {
      type: "message_start",
      message: { id: `m${seq}`, usage: { input_tokens: 10, cache_read_input_tokens: input - 10 } },
    },
    parent_tool_use_id: parent ?? null,
    session_id: "s1",
  },
});

function answerContext(c: Controller, body: Record<string, unknown> | null): void {
  const request = sent.findLast(
    (m) => (m.request as Record<string, unknown> | undefined)?.subtype === "get_context_usage",
  );
  const id = request?.request_id as string;
  c.receive({ seq: ++seq, dir: "in", message: request });
  c.receive({
    seq: ++seq,
    dir: "out",
    message: {
      type: "control_response",
      response: body
        ? { subtype: "success", request_id: id, response: body }
        : { subtype: "error", request_id: id, error: "busy" },
    },
  });
  c.flushNow();
}

const CONTEXT = {
  categories: [
    { name: "Messages", tokens: 1_000, kind: "used" },
    { name: "Free space", tokens: 199_000, kind: "free" },
  ],
  totalTokens: 1_000,
  maxTokens: 200_000,
  percentage: 1,
};

function asked(): Record<string, unknown>[] {
  return sent
    .filter((message) => message.type === "control_request")
    .map((message) => message.request as Record<string, unknown>);
}

beforeEach(() => resetPlanUsage());

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  sent.length = 0;
});

const USAGE = { subtype: "get_usage", skip_behaviors: true };
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("the line under the composer", () => {
  test("asks for the context as each turn ends, with no one looking at the tab, and the profile's usage", () => {
    const c = running();
    c.receive(result());
    expect(asked()).toEqual([{ subtype: "get_context_usage" }, USAGE]);
  });

  test("two tabs of one profile ending their turns ask for its usage once", () => {
    const a = running();
    const b = running();
    a.receive(result());
    b.receive(result());
    expect(asked().filter((r) => r.subtype === "get_usage")).toEqual([USAGE]);
  });

  test("asks again after a compaction, mid-turn", () => {
    const c = running();
    c.receive({
      seq: ++seq,
      dir: "out",
      message: { type: "system", subtype: "compact_boundary", session_id: "s1" },
    });
    expect(asked()).toEqual([{ subtype: "get_context_usage" }]);
  });

  test("a turn's end replayed from the log asks for nothing", () => {
    const c = running();
    c.receive(result(true));
    expect(asked()).toEqual([]);
  });

  test("asks for the plan's limits alone as it is shown, not again while the profile's are being fetched", async () => {
    const c = running();
    c.refreshUsageLine();
    await settle();
    c.refreshUsageLine();
    await settle();
    expect(asked()).toEqual([
      { subtype: "get_context_usage" },
      USAGE,
      { subtype: "get_context_usage" },
    ]);
  });

  test("an older Claude Code is asked for its usage as before", async () => {
    const c = running("2.1.300");
    c.refreshUsageLine();
    await settle();
    expect(asked()).toContainEqual({ subtype: "get_usage" });
  });

  test("a turn begun with no count asks for one as its first API call comes, and the calls after move it on", async () => {
    const c = running();
    c.receive(callStart(5_000));
    c.flushNow();
    expect(asked()).toEqual([{ subtype: "get_context_usage" }]);
    c.receive(callStart(6_000));
    c.flushNow();
    expect(asked()).toHaveLength(1);
    answerContext(c, CONTEXT);
    await settle();
    expect(c.state.model.contextUsage).toEqual(CONTEXT);
    c.receive(callStart(50_000));
    c.flushNow();
    expect(asked()).toHaveLength(1);
    expect(c.state.model.contextUsage).toMatchObject({
      totalTokens: 50_000,
      maxTokens: 200_000,
      percentage: 25,
      categories: [
        { name: "Messages", tokens: 1_000, kind: "used" },
        { name: "Free space", tokens: 150_000, kind: "free" },
      ],
    });
  });

  test("a failed ask for the count is not made again for each call of the turn, but the next turn's", async () => {
    const c = running();
    c.receive(callStart(5_000));
    c.flushNow();
    answerContext(c, null);
    await settle();
    c.receive(callStart(6_000));
    c.flushNow();
    expect(asked()).toEqual([{ subtype: "get_context_usage" }]);
    c.receive(result());
    c.flushNow();
    answerContext(c, null);
    await settle();
    c.receive(callStart(7_000));
    c.flushNow();
    c.receive(callStart(8_000));
    c.flushNow();
    expect(asked().filter((r) => r.subtype === "get_context_usage")).toHaveLength(3);
  });

  test("a call with a count already, a subagent's, or one replayed asks nothing", async () => {
    const c = running();
    c.receive(callStart(5_000, "toolu_1"));
    c.receive({ ...callStart(5_000), replay: true });
    c.flushNow();
    expect(asked()).toEqual([]);
    c.refreshUsageLine();
    await settle();
    answerContext(c, CONTEXT);
    await settle();
    sent.length = 0;
    c.receive(callStart(6_000));
    c.flushNow();
    expect(asked()).toEqual([]);
  });

  test("a Claude Code that cannot tell the context is not asked mid-turn", () => {
    const c = running("2.1.100");
    c.receive(callStart(5_000));
    c.flushNow();
    expect(asked()).toEqual([]);
  });

  test("a program not running is asked nothing", () => {
    const c = new ChatController({ workspaceId: "ws-usage", tabId: `t${++seq}`, cwd: "/p" }, {});
    live.push(c);
    c.receive(result());
    c.refreshUsageLine();
    expect(asked()).toEqual([]);
  });
});
