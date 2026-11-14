/** A watched chat's changes: found by the store's objects, sent as an update. */
import { describe, expect, test } from "bun:test";
import type { ChatPage } from "../../../../../packages/remote-protocol/src";
import type {
  ChatItem,
  ChatModel,
  ToolCall,
} from "../../../../../src/renderer/services/chat/model";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { applyUpdate } from "../../../../../src/renderer/services/remote/chat-model";
import { chatPageOf } from "../../../../../src/renderer/services/remote/chat-page";
import {
  changesOf,
  sentOf,
  windowStart,
} from "../../../../../src/renderer/services/remote/chat-watch";

const user = (key: string): ChatItem => ({
  kind: "user",
  key,
  text: key,
  images: [],
  state: "taken",
});
const said = (key: string, ...tools: string[]): ChatItem => ({
  kind: "assistant",
  key,
  messageId: `m-${key}`,
  blocks: [
    { type: "text", text: key },
    ...tools.map((id) => ({ type: "tool" as const, toolUseId: id })),
  ],
});
const tool = (id: string, status: ToolCall["status"] = "running"): ToolCall => ({
  id,
  name: "Bash",
  input: { command: "ls" },
  status,
  parentToolUseId: null,
});
const source = (model: Partial<ChatModel>) => ({
  agent: "claude" as const,
  title: "T",
  chat: { ...emptyTabState(), model: { ...emptyModel(), ...model } },
});

describe("a watched chat's changes", () => {
  const items = [user("a"), said("b", "t1")];
  const tools = { t1: tool("t1") };
  const before = source({ items, tools, running: true });

  test("nothing changed is nothing to send", () => {
    expect(
      changesOf(sentOf(before, 0), sentOf(source({ items, tools, running: true }), 0)),
    ).toBeNull();
  });

  test("sends only the items and calls that are new objects, and the status when it changed", () => {
    const done = tool("t1", "done");
    const after = source({ items: [...items, said("c")], tools: { t1: done }, running: false });
    const change = changesOf(sentOf(before, 0), sentOf(after, 0));
    expect(change?.items.map((i) => [i.index, i.item.key])).toEqual([[2, "c"]]);
    expect(Object.keys(change?.tools ?? {})).toEqual(["t1"]);
    expect(change?.status?.running).toBe(false);
    expect(change?.total).toBe(3);
  });

  test("a conversation that got shorter is cut, and the window moves back when it must", () => {
    const after = source({ items: [user("z")], tools: {} });
    const change = changesOf(sentOf(before, 0), sentOf(after, 0));
    expect(change?.total).toBe(1);
    expect(change?.items.map((i) => i.item.key)).toEqual(["z"]);
    expect(windowStart(150, 40, 100)).toBe(0);
    expect(windowStart(150, 400, 100)).toBe(150);
    expect(windowStart(150, 120, 100)).toBe(20);
  });

  test("the watcher's page with each update is the page read anew", () => {
    let page: ChatPage = chatPageOf(before);
    let sent = sentOf(before, page.start);
    let rev = 0;
    const steps = [
      source({
        items,
        tools,
        running: true,
        streaming: { messageId: "m", blocks: { 0: { type: "text", text: "He" } } },
      }),
      source({
        items: [...items, said("c", "t2")],
        tools: { ...tools, t2: tool("t2") },
        running: true,
      }),
      source({
        items: [...items, said("c", "t2")],
        tools: { t1: tool("t1", "done"), t2: tool("t2", "done") },
      }),
    ];
    for (const step of steps) {
      const now = sentOf(step, sent.window.start);
      const change = changesOf(sent, now);
      sent = now;
      if (change) page = applyUpdate(page, { watchId: "w", rev: ++rev, ...change });
      expect(page).toEqual(chatPageOf(step));
    }
  });
});

describe("putting an update in a page", () => {
  const page: ChatPage = {
    ...chatPageOf(source({})),
    start: 10,
    total: 12,
    items: [
      { kind: "notice", key: "n10", code: "x" },
      { kind: "notice", key: "n11", code: "x" },
    ],
  };
  const update = { watchId: "w", rev: 1, tools: {}, tasks: {}, agentItems: {} };

  test("puts items at their index and grows the list", () => {
    const next = applyUpdate(page, {
      ...update,
      total: 13,
      items: [
        { index: 11, item: { kind: "notice", key: "n11b", code: "x" } },
        { index: 12, item: { kind: "notice", key: "n12", code: "x" } },
      ],
    });
    expect([next.start, next.total]).toEqual([10, 13]);
    expect(next.items.map((i) => i.key)).toEqual(["n10", "n11b", "n12"]);
  });

  test("cuts the list at a shorter total, and moves its start back for an earlier item", () => {
    const next = applyUpdate(page, {
      ...update,
      total: 2,
      items: [
        { index: 0, item: { kind: "notice", key: "a", code: "x" } },
        { index: 1, item: { kind: "notice", key: "b", code: "x" } },
      ],
    });
    expect([next.start, next.total]).toEqual([0, 2]);
    expect(next.items.map((i) => i.key)).toEqual(["a", "b"]);
  });
});
