/**
 * The side panel and the composer take a tab's state beside its streaming
 * reply: a chunk of the reply leaves it the same, anything else they show
 * gives a new one.
 */
import { describe, expect, test } from "bun:test";
import { sameBesideStream } from "../../../../../src/renderer/services/chat/beside-stream";
import { applyLines } from "../../../../../src/renderer/services/chat/claude/stream-model";
import { type ChatLine, emptyModel } from "../../../../../src/renderer/services/chat/model";
import { type ChatTabState, emptyTabState } from "../../../../../src/renderer/services/chat/store";

let seq = 0;
const out = (message: unknown): ChatLine => ({ seq: ++seq, dir: "out", message });
const stream = (event: unknown) => out({ type: "stream_event", event });

/** A tab whose turn runs and whose reply has begun to stream. */
function streamingTab(): ChatTabState {
  const model = applyLines(emptyModel(), [
    { seq: ++seq, dir: "in", message: { type: "user", message: { role: "user", content: "hi" } } },
    stream({ type: "message_start", message: { id: "m1", usage: {} } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ]);
  return { ...emptyTabState(), phase: "ready", model };
}

function withLines(tab: ChatTabState, lines: ChatLine[]): ChatTabState {
  return { ...tab, model: applyLines(tab.model, lines) };
}

describe("the state beside a streaming reply", () => {
  test("a chunk of the reply's text leaves it the same", () => {
    const tab = streamingTab();
    const next = withLines(tab, [
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
    ]);
    expect(next.model.streaming).not.toBe(tab.model.streaming);
    expect(sameBesideStream(tab, next)).toBe(true);
  });

  test("a call the reply starts makes it new", () => {
    const tab = streamingTab();
    const next = withLines(tab, [
      stream({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t1", name: "Bash" },
      }),
    ]);
    expect(sameBesideStream(tab, next)).toBe(false);
  });

  test("the reply's message, and the turn's end, make it new", () => {
    const tab = streamingTab();
    const answered = withLines(tab, [
      stream({ type: "message_stop" }),
      out({
        type: "assistant",
        message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Hello" }] },
      }),
    ]);
    expect(sameBesideStream(tab, answered)).toBe(false);
    const ended = withLines(answered, [
      out({ type: "result", subtype: "success", is_error: false, result: "" }),
    ]);
    expect(sameBesideStream(answered, ended)).toBe(false);
  });

  test("a change to the tab beside its model makes it new", () => {
    const tab = streamingTab();
    expect(sameBesideStream(tab, { ...tab, queue: [{ id: "q", text: "next", images: [] }] })).toBe(
      false,
    );
    expect(sameBesideStream(tab, { ...tab, phase: "ended" })).toBe(false);
    expect(sameBesideStream(tab, { ...tab, reveal: { part: "jobs", seq: 1 } })).toBe(false);
  });
});
