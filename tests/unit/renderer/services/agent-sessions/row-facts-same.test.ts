/**
 * A list row reads its own conversation's facts and keeps the ones it has
 * while they say the same: a chunk of a reply streaming in gives facts
 * worked out again, equal, and renders no row.
 */
import { describe, expect, test } from "bun:test";
import {
  chatRowFacts,
  type RowFacts,
} from "../../../../../src/renderer/services/agent-sessions/rows";
import { sameRowFacts } from "../../../../../src/renderer/services/agent-sessions/use-row-facts";
import {
  applyLines,
  type ChatLine,
  emptyModel,
} from "../../../../../src/renderer/services/chat/model";

const facts: RowFacts = {
  wait: { kind: "permission", tool: "Bash", target: "ls" },
  tool: { name: "Read", target: "a.ts" },
  todos: { done: 1, total: 3 },
  subagents: 2,
  context: 40,
};

describe("a row's facts", () => {
  test("worked out again from a reply's chunk say the same", () => {
    let seq = 0;
    const stream = (event: unknown): ChatLine => ({
      seq: ++seq,
      dir: "out",
      message: { type: "stream_event", event },
    });
    const before = applyLines(emptyModel(), [
      {
        seq: ++seq,
        dir: "in",
        message: { type: "user", message: { role: "user", content: "hi" } },
      },
      stream({ type: "message_start", message: { id: "m1", usage: {} } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ]);
    const after = applyLines(before, [
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
    ]);
    const a = chatRowFacts(before);
    const b = chatRowFacts(after);
    expect(b).not.toBe(a);
    expect(sameRowFacts(a, b)).toBe(true);
  });

  test("equal field by field are the same", () => {
    expect(sameRowFacts(facts, structuredClone(facts))).toBe(true);
  });

  test("differ by any field they show", () => {
    const changes: Partial<RowFacts>[] = [
      { wait: { kind: "permission", tool: "Bash", target: "pwd" } },
      { wait: { kind: "plan", text: "Plan" } },
      { wait: undefined },
      { tool: { name: "Edit", target: "a.ts" } },
      { tool: undefined },
      { todos: { done: 2, total: 3 } },
      { subagents: 1 },
      { context: 41 },
    ];
    for (const change of changes) {
      expect(sameRowFacts(facts, { ...facts, ...change })).toBe(false);
    }
  });
});
