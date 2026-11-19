import { expect, test } from "bun:test";
import { generatingElapsed } from "../../../../../src/renderer/components/chat/status-line";
import {
  applyCodexLine,
  emptyCodexModel,
} from "../../../../../src/renderer/services/chat/codex-model";
import {
  applyLine,
  type ChatModel,
  emptyModel,
} from "../../../../../src/renderer/services/chat/model";

test("Codex silence is measured from the last turn, tool, text, or reasoning signal", () => {
  let model = { ...emptyCodexModel(), threadId: "thread" };
  let seq = 0;
  const event = (at: number, method: string, params: Record<string, unknown>) => {
    model = applyCodexLine(model, {
      seq: ++seq,
      at,
      dir: "out",
      message: { method, params: { threadId: "thread", turnId: "turn", ...params } },
    }) as typeof model;
  };
  event(1_000, "turn/started", { turn: { id: "turn" } });
  expect(generatingElapsed(model, 3_999)).toBeUndefined();
  expect(generatingElapsed(model, 4_000)).toBe(3_000);

  event(5_000, "item/started", { item: { id: "call", type: "commandExecution" } });
  expect(generatingElapsed(model, 10_000)).toBeUndefined();
  event(11_000, "item/completed", {
    item: { id: "call", type: "commandExecution", startedAtMs: 5_000 },
  });
  expect(generatingElapsed(model, 12_000)).toBeUndefined();
  expect(generatingElapsed(model, 15_000)).toBe(4_000);

  event(16_000, "item/agentMessage/delta", { itemId: "text", delta: "hello" });
  event(18_000, "item/reasoning/textDelta", { itemId: "thought", delta: "thinking" });
  expect(generatingElapsed(model, 20_999)).toBeUndefined();
  event(21_000, "item/agentMessage/delta", { threadId: "child", itemId: "other", delta: "hi" });
  expect(generatingElapsed(model, 22_000)).toBe(4_000);
  expect(generatingElapsed({ ...model, interrupting: true }, 23_000)).toBeUndefined();
  event(23_000, "turn/completed", { turn: { id: "turn" } });
  expect(generatingElapsed(model, 24_000)).toBeUndefined();
});

test("Claude streaming resets the timer even for reasoning and approval suppresses it", () => {
  let model: ChatModel = emptyModel();
  let seq = 0;
  const stream = (at: number, event: Record<string, unknown>) => {
    model = applyLine(model, {
      seq: ++seq,
      at,
      dir: "out",
      message: { type: "stream_event", event },
    });
  };
  model = applyLine(model, { seq: ++seq, at: 1_000, dir: "in", message: { type: "user" } });
  stream(2_000, { type: "message_start", message: { id: "message" } });
  stream(3_000, { type: "content_block_start", index: 0, content_block: { type: "thinking" } });
  stream(5_000, {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "thinking" },
  });
  expect(generatingElapsed(model, 7_999)).toBeUndefined();
  expect(generatingElapsed(model, 8_000)).toBe(3_000);
  model = applyLine(model, {
    seq: ++seq,
    dir: "out",
    message: {
      type: "control_request",
      request_id: "confirm",
      request: { subtype: "can_use_tool", tool_name: "Bash" },
    },
  });
  expect(model.permissions).toHaveLength(1);
  expect(generatingElapsed(model, 9_000)).toBeUndefined();
});
