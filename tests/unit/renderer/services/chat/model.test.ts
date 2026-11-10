import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyLine,
  applyLines,
  type ChatLine,
  type ChatModel,
  emptyModel,
  isWaiting,
} from "../../../../../src/renderer/services/chat/model";

// Three turns recorded from claude 2.1.318 with the app's flags: a Write
// outside the folder (a permission request) and a Bash ls; a one-word
// answer, between two mode switches; a Bash sleep stopped by interrupt.
const FIXTURE: ChatLine[] = readFileSync(
  join(import.meta.dir, "../../../../fixtures/chat/three-turns.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as ChatLine);

function upTo(predicate: (line: ChatLine) => boolean): ChatLine[] {
  const index = FIXTURE.findIndex(predicate);
  if (index < 0) throw new Error("line not in fixture");
  return FIXTURE.slice(0, index + 1);
}

function messageOf(line: ChatLine): Record<string, unknown> {
  return line.message as Record<string, unknown>;
}

const started: ChatLine = { seq: 0, dir: "sys", message: { event: "start", pid: 1 } };

function run(lines: ChatLine[]): ChatModel {
  return applyLines(applyLine(emptyModel(), { ...started, seq: 0.5 }), lines, 1000);
}

describe("chat model from a recorded conversation", () => {
  test("the whole conversation", () => {
    const model = run(FIXTURE);
    expect(model.sessionId).toBe("f676b90f-cba3-42f4-85ac-18f5f3aaab1b");
    expect(model.model).toBe("claude-haiku-5-5");
    expect(model.version).toBe("2.1.318");
    expect(model.permissionMode).toBe("default");
    expect(model.running).toBe(false);
    expect(model.permissions).toEqual([]);
    expect(model.outgoing).toEqual({});
    expect(model.streaming).toBeNull();

    const users = model.items.filter((i) => i.kind === "user");
    expect(users).toHaveLength(3);
    expect(users.every((u) => u.state === "taken" && u.uuid)).toBe(true);

    const tools = Object.values(model.tools);
    expect(tools.map((t) => [t.name, t.status])).toEqual([
      ["Write", "done"],
      ["Bash", "done"],
      ["Bash", "stopped"],
    ]);
    expect(model.items.some((i) => i.kind === "notice" && i.code === "interrupted")).toBe(true);
    // The interrupt's error result is not shown as an error.
    expect(model.items.some((i) => i.kind === "notice" && i.code === "error")).toBe(false);
    expect(model.lastResult?.terminalReason).toBe("aborted_tools");
    expect(model.costUsd).toBeGreaterThan(0);
    expect(model.init?.models.map((m) => m.value)).toEqual(["default", "haiku"]);
    expect(model.init?.commands.map((c) => c.name)).toEqual(["compact", "review"]);
    expect(model.rateLimit?.status).toBe("allowed");
  });

  test("the tab's cost adds up each process's running total", () => {
    const result = (seq: number, cost: number): ChatLine => ({
      seq,
      dir: "out",
      message: { type: "result", subtype: "success", total_cost_usd: cost },
    });
    const model = applyLines(emptyModel(), [
      { seq: 1, dir: "sys", message: { event: "start", pid: 1 } },
      result(2, 0.002),
      result(3, 0.003),
      { seq: 4, dir: "sys", message: { event: "exit", code: 0 } },
      { seq: 5, dir: "sys", message: { event: "start", pid: 2 } },
      result(6, 0.001),
    ]);
    expect(model.costUsd).toBeCloseTo(0.004, 10);
    expect(model.processCostUsd).toBe(0.001);
  });

  test("/clear starts the conversation over under the new session id", () => {
    const sid = (seq: number, id: string): ChatLine => ({
      seq,
      dir: "out",
      message: { type: "system", subtype: "init", session_id: id },
    });
    const before = run(FIXTURE);
    const lastSeq = before.lastSeq;
    // As 2.1.318 answers a /clear: the reset, then an init with the new id.
    const model = applyLines(before, [
      {
        seq: lastSeq + 1,
        dir: "out",
        message: { type: "conversation_reset", session_id: before.sessionId },
      },
      sid(lastSeq + 2, "new-session"),
      { seq: lastSeq + 3, dir: "out", message: { type: "result", subtype: "success" } },
    ]);
    expect(model.sessionId).toBe("new-session");
    expect(model.items.map((i) => (i.kind === "notice" ? i.code : i.kind))).toEqual(["cleared"]);
    expect(model.tools).toEqual({});
    expect(model.clears).toBe(1);
  });

  test("a policy refusing bypass mode is remembered", () => {
    const refusal =
      "Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration";
    const model = applyLines(emptyModel(), [
      { seq: 1, dir: "sys", message: { event: "start", pid: 1 } },
      {
        seq: 2,
        dir: "in",
        message: {
          type: "control_request",
          request_id: "a1",
          request: { subtype: "set_permission_mode", mode: "bypassPermissions" },
        },
      },
      {
        seq: 3,
        dir: "out",
        message: {
          type: "control_response",
          response: { subtype: "error", request_id: "a1", error: refusal },
        },
      },
    ]);
    expect(model.bypassBlocked).toBe(refusal);
    expect(model.permissionMode).toBeUndefined();
  });

  test("a permission request waits on the card until the app answers it", () => {
    const asked = run(upTo((l) => messageOf(l).type === "control_request" && l.dir === "out"));
    expect(asked.permissions).toHaveLength(1);
    expect(asked.permissions[0]).toMatchObject({
      toolName: "Write",
      displayName: "Write",
      decisionReason: "Path is outside allowed working directories",
    });
    expect(asked.permissions[0].suggestions).toHaveLength(2);
    expect(asked.running).toBe(true);

    const answered = run(upTo((l) => messageOf(l).type === "control_response" && l.dir === "in"));
    expect(answered.permissions).toEqual([]);
  });

  test("text streams in before its message arrives whole", () => {
    // The last turn's first answer text, mid-stream.
    const lines = upTo(
      (l) =>
        messageOf(l).type === "stream_event" &&
        (messageOf(l).event as { delta?: { type?: string } }).delta?.type === "text_delta",
    );
    const model = run(lines);
    const blocks = Object.values(model.streaming?.blocks ?? {});
    expect(blocks.some((b) => b.type === "text" && b.text.length > 0)).toBe(true);

    // When the assistant line comes, the streamed block is in the item instead.
    const whole = run(
      upTo((l) => l.seq > lines[lines.length - 1].seq && messageOf(l).type === "assistant"),
    );
    expect(Object.values(whole.streaming?.blocks ?? {})).toEqual([]);
    const last = whole.items[whole.items.length - 1];
    expect(last.kind === "assistant" && last.blocks.some((b) => b.type === "text")).toBe(true);
  });

  test("a tool row appears as its input streams", () => {
    const whole = FIXTURE.findIndex(
      (l) => messageOf(l).type === "assistant" && JSON.stringify(l.message).includes('"tool_use"'),
    );
    const tool = Object.values(run(FIXTURE.slice(0, whole)).tools)[0];
    expect(tool).toMatchObject({ name: "Write", status: "streaming" });
    expect(tool.partialInput?.length).toBeGreaterThan(0);
  });

  test("the first mode switch is read from its answer", () => {
    const lines = upTo((l) => {
      const m = messageOf(l);
      return (
        m.type === "control_response" &&
        (m.response as { request_id?: string }).request_id === "app-3"
      );
    });
    expect(run(lines).permissionMode).toBe("acceptEdits");
  });

  test("a sent message shows before the CLI takes it", () => {
    const model = applyLine(emptyModel(), {
      seq: 1,
      dir: "in",
      message: { type: "user", message: { role: "user", content: "hi" } },
    });
    expect(model.items).toEqual([
      { kind: "user", key: "u1", text: "hi", images: [], state: "sent", at: expect.any(Number) },
    ]);
    expect(model.running).toBe(true);
  });

  test("lines already applied are skipped", () => {
    const model = run(FIXTURE);
    expect(applyLines(model, FIXTURE.slice(0, 10))).toBe(model);
  });

  test("a line's time is the agent's, replayed or not", () => {
    const model = applyLine(emptyModel(), {
      seq: 1,
      dir: "in",
      replay: true,
      at: 1234,
      message: { type: "user", message: { role: "user", content: "hi" } },
    });
    expect((model.items[0] as { at?: number }).at).toBe(1234);
  });

  test("a message's uuid is its last part's", () => {
    const model = run(FIXTURE);
    const lastUuid = new Map<string, string>();
    for (const line of FIXTURE) {
      const message = messageOf(line);
      const id = (message.message as { id?: string } | undefined)?.id;
      if (message.type === "assistant" && id && typeof message.uuid === "string") {
        lastUuid.set(id, message.uuid);
      }
    }
    const assistants = model.items.filter((item) => item.kind === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    for (const item of assistants) {
      if (item.kind === "assistant") expect(item.uuid).toBe(lastUuid.get(item.messageId));
    }
  });

  test("replayed lines carry no time of their own", () => {
    const model = applyLine(emptyModel(), {
      seq: 1,
      dir: "in",
      replay: true,
      message: { type: "user", message: { role: "user", content: "hi" } },
    });
    expect((model.items[0] as { at?: number }).at).toBeUndefined();
  });
});

describe("chat model process lines", () => {
  test("an exit ends the turn and drops its requests", () => {
    let model = run(upTo((l) => messageOf(l).type === "control_request" && l.dir === "out"));
    model = applyLine(model, {
      seq: 1000,
      dir: "sys",
      message: { event: "exit", code: 1, stderrTail: "boom" },
    });
    expect(model.process).toBe("exited");
    expect(model.running).toBe(false);
    expect(model.permissions).toEqual([]);
    expect(model.exit).toEqual({ code: 1, stderrTail: "boom" });
    expect(Object.values(model.tools).every((t) => t.status !== "running")).toBe(true);
    const notice = model.items[model.items.length - 1];
    expect(notice).toMatchObject({ kind: "notice", code: "exited", detail: "boom" });

    model = applyLine(model, { seq: 1001, dir: "sys", message: { event: "start", pid: 2 } });
    expect(model.process).toBe("running");
    expect(model.items[model.items.length - 1]).toMatchObject({ code: "restarted" });
  });

  test("an exit's output reads without the colours it was written in", () => {
    const esc = String.fromCharCode(0x1b);
    // A line as codex 0.166 wrote it on Windows, colours and all.
    const written =
      `${esc}[2m2026-11-06T03:00:34.233537Z${esc}[0m ${esc}[31mERROR${esc}[0m ` +
      `${esc}[2mcodex_app_server${esc}[0m${esc}[2m:${esc}[0m Invalid configuration; using defaults.\r\n`;
    const model = applyLine(emptyModel(), {
      seq: 1,
      dir: "sys",
      message: { event: "exit", code: 1, stderrTail: written },
    });
    const shown =
      "2026-11-06T03:00:34.233537Z ERROR codex_app_server: Invalid configuration; using defaults.\n";
    expect(model.exit?.stderrTail).toBe(shown);
    expect(model.items[model.items.length - 1]).toMatchObject({ code: "exited", detail: shown });
  });

  test("a log that starts with a resumed program says so", () => {
    const resumed = applyLine(emptyModel(), {
      seq: 7,
      dir: "sys",
      message: { event: "start", pid: 1, resumed: true },
    });
    expect(resumed.resumed).toBe(true);
    const fresh = applyLine(emptyModel(), {
      seq: 1,
      dir: "sys",
      message: { event: "start", pid: 1 },
    });
    expect(fresh.resumed).toBe(false);
    // A later restart of the program does not change how the log began.
    const later = applyLine(
      applyLine(fresh, { seq: 2, dir: "sys", message: { event: "exit", code: 0 } }),
      { seq: 3, dir: "sys", message: { event: "start", pid: 2, resumed: true } },
    );
    expect(later.resumed).toBe(false);
  });

  test("an error answer to a control request is shown", () => {
    let model = applyLine(emptyModel(), {
      seq: 1,
      dir: "in",
      message: {
        type: "control_request",
        request_id: "r1",
        request: { subtype: "set_permission_mode", mode: "bypassPermissions" },
      },
    });
    model = applyLine(model, {
      seq: 2,
      dir: "out",
      message: {
        type: "control_response",
        response: { subtype: "error", request_id: "r1", error: "Cannot set permission mode" },
      },
    });
    expect(model.outgoing).toEqual({});
    expect(model.items[0]).toMatchObject({
      kind: "notice",
      code: "error",
      detail: "Cannot set permission mode",
    });
  });

  test("a denied request marks its tool", () => {
    let model = applyLine(emptyModel(), {
      seq: 1,
      dir: "out",
      message: {
        type: "assistant",
        message: {
          id: "m1",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf x" } }],
        },
      },
    });
    model = applyLine(model, {
      seq: 2,
      dir: "out",
      message: {
        type: "control_request",
        request_id: "p1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf x" },
          tool_use_id: "t1",
        },
      },
    });
    model = applyLine(model, {
      seq: 3,
      dir: "in",
      message: {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "p1",
          response: { behavior: "deny", message: "no" },
        },
      },
    });
    expect(model.tools.t1.status).toBe("denied");
    expect(model.permissions).toEqual([]);
  });

  test("a subagent's messages stay out of the main thread", () => {
    const model = applyLine(emptyModel(), {
      seq: 1,
      dir: "out",
      message: {
        type: "assistant",
        parent_tool_use_id: "agent-1",
        message: {
          id: "m1",
          content: [
            { type: "text", text: "sub" },
            { type: "tool_use", id: "t2", name: "Read", input: {} },
          ],
        },
      },
    });
    expect(model.items).toEqual([]);
    expect(model.tools.t2.parentToolUseId).toBe("agent-1");
  });
});

describe("messages written during a turn", () => {
  const sent = (seq: number, text: string, uuid: string, more: Record<string, unknown> = {}) =>
    ({
      seq,
      dir: "in",
      message: { type: "user", message: { role: "user", content: text }, uuid, ...more },
    }) as ChatLine;
  const echo = (seq: number, text: string, uuid: string) =>
    ({
      seq,
      dir: "out",
      message: { type: "user", isReplay: true, uuid, message: { role: "user", content: text } },
    }) as ChatLine;
  const toolUse = (seq: number) =>
    ({
      seq,
      dir: "out",
      message: {
        type: "assistant",
        message: {
          id: "m1",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 9" } }],
        },
      },
    }) as ChatLine;
  const cancelled = (seq: number, uuid: string) =>
    ({
      seq,
      dir: "out",
      message: { type: "command_lifecycle", command_uuid: uuid, state: "cancelled" },
    }) as ChatLine;
  const users = (model: ChatModel) =>
    model.items.flatMap((item) =>
      item.kind === "user"
        ? [`${item.text}:${item.state}${isWaiting(item) ? ":waiting" : ""}`]
        : [],
    );

  test("a command's output the CLI echoes, as setting the model, is no message of the user's", () => {
    let model = applyLines(emptyModel(), [sent(1, "go", "u-1"), toolUse(2)]);
    model = applyLine(
      model,
      echo(
        3,
        "<local-command-stdout>Set model to `haiku (claude-haiku-5-5)`</local-command-stdout>",
        "c-1",
      ),
    );
    // Nor does it take the message the user wrote.
    expect(users(model)).toEqual(["go:sent"]);
    model = applyLine(model, echo(4, "go", "u-1"));
    expect(users(model)).toEqual(["go:taken"]);
    // /compact's, which its own notice tells.
    model = applyLine(
      model,
      echo(5, "<local-command-stdout>Compacted </local-command-stdout>", "c-2"),
    );
    expect(users(model)).toEqual(["go:taken"]);
  });

  test("the one that starts a turn does not wait, and is taken in place", () => {
    let model = applyLines(emptyModel(), [sent(1, "go", "u-1"), toolUse(2)]);
    expect(users(model)).toEqual(["go:sent"]);
    model = applyLine(model, echo(3, "go", "u-1"));
    expect(model.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(model.items[0]).toMatchObject({ state: "taken", uuid: "u-1", sentUuid: "u-1" });
  });

  test("one written during the turn waits, then is read after what the turn did", () => {
    let model = applyLines(emptyModel(), [
      sent(1, "go", "u-1"),
      echo(2, "go", "u-1"),
      sent(3, "and this", "u-2"),
      toolUse(4),
    ]);
    expect(users(model)).toEqual(["go:taken", "and this:sent:waiting"]);
    model = applyLine(model, echo(5, "and this", "u-2"));
    expect(model.items.map((item) => (item.kind === "user" ? item.text : item.kind))).toEqual([
      "go",
      "assistant",
      "and this",
    ]);
    expect(model.items[2]).toMatchObject({ state: "taken", uuid: "u-2" });
    expect(isWaiting(model.items[2])).toBe(false);
  });

  test("one taken back is dropped, and the echo names the one read", () => {
    let model = applyLines(emptyModel(), [
      sent(1, "go", "u-1"),
      echo(2, "go", "u-1"),
      sent(3, "first", "u-2"),
      sent(4, "second", "u-3"),
      cancelled(5, "u-2"),
    ]);
    expect(users(model)).toEqual(["go:taken", "second:sent:waiting"]);
    model = applyLine(model, echo(6, "second", "u-3"));
    expect(users(model)).toEqual(["go:taken", "second:taken"]);
  });

  test("one to read at once does not wait", () => {
    const model = applyLines(emptyModel(), [
      sent(1, "go", "u-1"),
      sent(2, "now", "u-2", { priority: "now" }),
    ]);
    expect(users(model)).toEqual(["go:sent", "now:sent"]);
  });

  test("one taken after the turn ended begins the next turn, which its result ends", () => {
    const result = (seq: number) =>
      ({ seq, dir: "out", message: { type: "result", subtype: "success" } }) as ChatLine;
    let model = run([
      sent(1, "go", "u-1"),
      echo(2, "go", "u-1"),
      sent(3, "and this", "u-2"),
      result(4),
    ]);
    expect(model.running).toBe(false);
    model = applyLine(model, echo(5, "and this", "u-2"));
    expect(model.running).toBe(true);
    expect(users(model)).toEqual(["go:taken", "and this:taken"]);
    model = applyLine(model, result(6));
    expect(model.running).toBe(false);
  });

  test("a message the CLI was given itself begins a turn: Remote Control's, a task's news", () => {
    const model = run([echo(1, "from the phone", "cli-1")]);
    expect(model.running).toBe(true);
    expect(users(model)).toEqual(["from the phone:taken"]);
  });

  test("a transcript's messages, and a command's output, begin no turn", () => {
    const model = run([
      { ...echo(1, "said before", "old-1"), replay: true },
      echo(2, "<local-command-stdout>Set model</local-command-stdout>", "c-1"),
    ]);
    expect(model.running).toBe(false);
  });

  test("an echo with no uuid of the app's takes the oldest sent", () => {
    const model = applyLines(emptyModel(), [
      { seq: 1, dir: "in", message: { type: "user", message: { role: "user", content: "a" } } },
      echo(2, "a", "cli-uuid"),
    ]);
    expect(model.items[0]).toMatchObject({ state: "taken", uuid: "cli-uuid" });
  });
});

describe("the plan's usage", () => {
  const usageAnswer = (seq: number, id: string, body: Record<string, unknown>): ChatLine[] => [
    {
      seq,
      dir: "in",
      message: { type: "control_request", request_id: id, request: { subtype: "get_usage" } },
    },
    {
      seq: seq + 0.5,
      dir: "out",
      message: {
        type: "control_response",
        response: { subtype: "success", request_id: id, response: body },
      },
    },
  ];
  const limits = { rate_limits: { limits: [{ kind: "session", percent: 40 }] } };

  test("an answer with no limits, as when the usage endpoint failed, keeps the last that had them", () => {
    const model = run([
      ...usageAnswer(1, "r1", limits),
      ...usageAnswer(2, "r2", { rate_limits: null }),
      ...usageAnswer(3, "r3", { rate_limits: { limits: [] } }),
    ]);
    expect(model.usage).toEqual(limits);
  });

  test("the first answer is taken, limits or not, and a later one with limits replaces it", () => {
    const first = run(usageAnswer(1, "r1", { rate_limits: null }));
    expect(first.usage).toEqual({ rate_limits: null });
    const later = applyLines(first, usageAnswer(2, "r2", limits));
    expect(later.usage).toEqual(limits);
  });
});

describe("initialize", () => {
  const initialized = (body: Record<string, unknown>) => {
    const asked = applyLine(emptyModel(), {
      seq: 1,
      dir: "in",
      message: { type: "control_request", request_id: "i1", request: { subtype: "initialize" } },
    });
    return applyLine(asked, {
      seq: 2,
      dir: "out",
      message: {
        type: "control_response",
        response: { subtype: "success", request_id: "i1", response: body },
      },
    });
  };

  test("the account it is signed in as, for /status", () => {
    const model = initialized({
      account: {
        email: "a@example.com",
        organization: "Org",
        subscriptionType: "Claude Team",
        apiProvider: "firstParty",
      },
    });
    expect(model.init?.account).toEqual({
      email: "a@example.com",
      organization: "Org",
      subscription: "Claude Team",
      provider: "firstParty",
    });
    expect(initialized({}).init?.account).toBeUndefined();
    expect(initialized({ account: {} }).init?.account).toBeUndefined();
  });
});
