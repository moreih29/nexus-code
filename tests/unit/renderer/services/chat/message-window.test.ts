import { describe, expect, test } from "bun:test";
import {
  indexOfCall,
  shownStart,
  windowStart,
} from "../../../../../src/renderer/services/chat/message-window";
import type { ChatItem } from "../../../../../src/renderer/services/chat/model";

const user = (n: number): ChatItem => ({
  kind: "user",
  key: `u${n}`,
  text: `message ${n}`,
  images: [],
  state: "taken",
});
const answer = (n: number, call?: string): ChatItem => ({
  kind: "assistant",
  key: `a${n}`,
  messageId: `m${n}`,
  blocks: [
    { type: "text", text: `answer ${n}` },
    ...(call ? [{ type: "tool" as const, toolUseId: call }] : []),
  ],
});

/** `turns` turns, each a message and `answers` answers. */
function conversation(turns: number, answers: number): ChatItem[] {
  const items: ChatItem[] = [];
  for (let t = 0; t < turns; t++) {
    items.push(user(t));
    for (let a = 0; a < answers; a++) items.push(answer(t * 100 + a, `call-${t}-${a}`));
  }
  return items;
}

describe("windowStart", () => {
  test("a conversation that fits renders whole", () => {
    expect(windowStart(conversation(3, 3), 12)).toBe(0);
    expect(windowStart(conversation(3, 3), 100)).toBe(0);
  });

  test("a longer one renders its last messages, from where a turn begins", () => {
    // 10 turns of 4 items: the last 10 start mid-turn (index 30), so the window goes back to the turn's message at 28.
    const items = conversation(10, 3);
    const start = windowStart(items, 10);
    expect(start).toBe(28);
    expect(items[start]?.kind).toBe("user");
    expect(items.length - start).toBeGreaterThanOrEqual(10);
  });

  test("a turn longer than twice the window does not pull the whole turn in", () => {
    const items = conversation(1, 1000);
    expect(windowStart(items, 50)).toBe(items.length - 50);
  });

  test("more asked for renders further back", () => {
    const items = conversation(100, 4);
    expect(windowStart(items, 50)).toBeGreaterThan(windowStart(items, 200));
  });
});

describe("shownStart", () => {
  test("at the bottom the rendered part follows the conversation", () => {
    expect(shownStart({ fresh: 500, held: 300, stuck: true, total: 650, size: 150 })).toBe(500);
  });

  test("up the list it stays where it was as messages come in", () => {
    expect(shownStart({ fresh: 350, held: 300, stuck: false, total: 500, size: 150 })).toBe(300);
  });

  test("earlier messages asked for render up the list too", () => {
    expect(shownStart({ fresh: 100, held: 300, stuck: false, total: 400, size: 300 })).toBe(100);
  });

  test("a view left up the list renders no more than twice the window", () => {
    expect(shownStart({ fresh: 850, held: 300, stuck: false, total: 1000, size: 150 })).toBe(700);
    expect(shownStart({ fresh: 860, held: 700, stuck: false, total: 1010, size: 150 })).toBe(710);
  });
});

describe("indexOfCall", () => {
  test("finds the message that holds a call", () => {
    const items = conversation(10, 3);
    expect(items[indexOfCall(items, new Set(["call-2-1"]))]?.key).toBe("a201");
  });

  test("finds the outermost call a chain names, and nothing for an unknown one", () => {
    const items = conversation(10, 3);
    expect(indexOfCall(items, new Set(["sub-call", "call-4-0"]))).toBe(
      items.findIndex((item) => item.key === "a400"),
    );
    expect(indexOfCall(items, new Set(["nope"]))).toBe(-1);
  });
});
